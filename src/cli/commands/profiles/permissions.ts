import { Command } from 'commander';
import { input, confirm, select, editor } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { promises as fs } from 'node:fs';
import {
  listPermissionsProfiles,
  getPermissionsProfile,
  createPermissionsProfile,
  deletePermissionsProfile,
  savePermissionsProfile,
  getPermissionsDescription,
} from '../../../services/permissions-profiles.js';
import { IamStatementSchema } from '../../../schemas/config.js';
import type { IamStatement } from '../../../schemas/config.js';
import { z } from 'zod';

const TEMPLATE_STATEMENTS = `[
  {
    "Sid": "AllowSageMaker",
    "Effect": "Allow",
    "Action": [
      "sagemaker:CreateEndpoint",
      "sagemaker:InvokeEndpoint"
    ],
    "Resource": "*"
  }
]`;

function parseStatements(raw: string): IamStatement[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON');
  }

  // Accept a full policy document with a Statement array
  if (
    parsed &&
    typeof parsed === 'object' &&
    'Statement' in parsed &&
    Array.isArray((parsed as { Statement: unknown }).Statement)
  ) {
    parsed = (parsed as { Statement: unknown }).Statement;
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      'Expected a JSON array of IAM statements (or a policy document with Statement)'
    );
  }

  if (parsed.length === 0) {
    throw new Error('Statements array must not be empty');
  }

  return z.array(IamStatementSchema).parse(parsed);
}

export const permissionsCommand = new Command('permissions')
  .description('Manage IAM permissions profiles for workstations')
  .action(async () => {
    const profiles = await listPermissionsProfiles();

    if (profiles.length === 0) {
      console.log(chalk.dim('\nNo permissions profiles configured.\n'));
      const create = await confirm({
        message: 'Would you like to create one now?',
        default: true,
      });
      if (create) {
        await createProfileInteractive();
      }
      return;
    }

    console.log(chalk.bold('\nPermissions Profiles:\n'));
    for (const profile of profiles) {
      const desc = getPermissionsDescription(profile);
      console.log(`  ${chalk.cyan(profile.name)}`);
      console.log(chalk.dim(`    ${desc}`));
      if (profile.description) {
        console.log(chalk.dim(`    ${profile.description}`));
      }
    }
    console.log();
    console.log(chalk.dim('Commands:'));
    console.log(chalk.dim('  clawdult profiles permissions create [name]  Create a new profile'));
    console.log(
      chalk.dim('  clawdult profiles permissions show <name>    Show profile statements')
    );
    console.log(
      chalk.dim('  clawdult profiles permissions edit <name>    Edit profile statements')
    );
    console.log(chalk.dim('  clawdult profiles permissions delete <name>  Delete a profile'));
    console.log();
  });

permissionsCommand
  .command('list')
  .description('List all permissions profiles')
  .action(async () => {
    const profiles = await listPermissionsProfiles();

    if (profiles.length === 0) {
      console.log(chalk.dim('\nNo permissions profiles configured.'));
      console.log(chalk.dim('Create one with: clawdult profiles permissions create [name]\n'));
      return;
    }

    console.log(chalk.bold('\nPermissions Profiles:\n'));
    for (const profile of profiles) {
      const desc = getPermissionsDescription(profile);
      console.log(`  ${chalk.cyan(profile.name)}`);
      console.log(chalk.dim(`    ${desc}`));
      if (profile.description) {
        console.log(chalk.dim(`    ${profile.description}`));
      }
    }
    console.log();
  });

permissionsCommand
  .command('create [name]')
  .description('Create a new permissions profile')
  .option('--from-file <path>', 'Load IAM policy statements from a JSON file')
  .action(async (providedName: string | undefined, options: { fromFile?: string }) => {
    await createProfileInteractive(providedName, options.fromFile);
  });

permissionsCommand
  .command('show <name>')
  .description('Show permissions profile statements')
  .action(async (name: string) => {
    const profile = await getPermissionsProfile(name);
    if (!profile) {
      console.log(chalk.red(`\nPermissions profile '${name}' not found.\n`));
      return;
    }

    console.log(chalk.bold(`\nPermissions Profile: ${chalk.cyan(name)}\n`));
    if (profile.description) {
      console.log(chalk.dim(`  ${profile.description}\n`));
    }
    console.log(chalk.dim(`  Created: ${profile.createdAt}`));
    console.log(chalk.dim(`  ${getPermissionsDescription(profile)}\n`));
    console.log(chalk.bold('Statements:\n'));
    console.log(JSON.stringify(profile.statements, null, 2));
    console.log();
  });

permissionsCommand
  .command('edit <name>')
  .description('Edit permissions profile statements')
  .action(async (name: string) => {
    const profile = await getPermissionsProfile(name);
    if (!profile) {
      console.log(chalk.red(`\nPermissions profile '${name}' not found.\n`));
      return;
    }

    console.log(chalk.bold(`\nEditing permissions profile: ${chalk.cyan(name)}\n`));

    const description = await input({
      message: 'Description (optional):',
      default: profile.description || '',
    });

    let statements: IamStatement[];
    if (process.env.EDITOR || process.env.VISUAL) {
      const result = await editor({
        message: 'Edit IAM policy statements (JSON):',
        default: JSON.stringify(profile.statements, null, 2),
      });

      try {
        statements = parseStatements(result);
      } catch (error) {
        console.log(
          chalk.red(
            `\nInvalid statements: ${error instanceof Error ? error.message : String(error)}\n`
          )
        );
        return;
      }
    } else {
      console.log(chalk.dim('\nCurrent statements:'));
      console.log(JSON.stringify(profile.statements, null, 2));
      console.log();

      const raw = await input({
        message: 'Paste new statements JSON (or press Enter to keep current):',
      });

      if (!raw.trim()) {
        statements = profile.statements;
      } else {
        try {
          statements = parseStatements(raw);
        } catch (error) {
          console.log(
            chalk.red(
              `\nInvalid statements: ${error instanceof Error ? error.message : String(error)}\n`
            )
          );
          return;
        }
      }
    }

    profile.description = description || undefined;
    profile.statements = statements;

    const spinner = ora('Saving permissions profile...').start();
    await savePermissionsProfile(profile);
    spinner.succeed(`Permissions profile '${name}' updated.`);
    console.log();
  });

permissionsCommand
  .command('delete <name>')
  .description('Delete a permissions profile')
  .action(async (name: string) => {
    const profile = await getPermissionsProfile(name);
    if (!profile) {
      console.log(chalk.red(`\nPermissions profile '${name}' not found.\n`));
      return;
    }

    const confirmed = await confirm({
      message: `Delete permissions profile '${name}'? This cannot be undone.`,
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.yellow('\nCancelled.\n'));
      return;
    }

    const spinner = ora('Deleting permissions profile...').start();
    await deletePermissionsProfile(name);
    spinner.succeed(`Permissions profile '${name}' deleted.`);
    console.log(
      chalk.dim(
        '\nNote: This does not detach the profile from running workstations. Use "clawdult permissions detach" for that.\n'
      )
    );
  });

async function createProfileInteractive(providedName?: string, fromFile?: string): Promise<void> {
  console.log(chalk.bold('\nCreate Permissions Profile\n'));
  console.log(chalk.dim('A permissions profile stores IAM policy statements that grant'));
  console.log(chalk.dim('additional AWS service access to workstations.\n'));

  const name =
    providedName ||
    (await input({
      message: 'Profile name:',
      validate: (v) => {
        if (!v.trim()) return 'Name is required';
        if (!/^[a-zA-Z0-9-_]+$/.test(v))
          return 'Use only letters, numbers, hyphens, and underscores';
        if (v.length > 50) return 'Max 50 characters';
        return true;
      },
    }));

  const existing = await getPermissionsProfile(name);
  if (existing) {
    console.log(
      chalk.yellow(
        `\nProfile '${name}' already exists. Use 'clawdult profiles permissions edit ${name}' to modify it.\n`
      )
    );
    return;
  }

  let statements: IamStatement[];

  if (fromFile) {
    const raw = await fs.readFile(fromFile, 'utf-8');
    try {
      statements = parseStatements(raw);
    } catch (error) {
      console.log(
        chalk.red(
          `\nFailed to parse ${fromFile}: ${error instanceof Error ? error.message : String(error)}\n`
        )
      );
      return;
    }
    console.log(chalk.dim(`  Loaded ${statements.length} statement(s) from ${fromFile}\n`));
  } else if (process.env.EDITOR || process.env.VISUAL) {
    const result = await editor({
      message: 'Enter IAM policy statements (JSON array):',
      default: TEMPLATE_STATEMENTS,
    });

    try {
      statements = parseStatements(result);
    } catch (error) {
      console.log(
        chalk.red(
          `\nInvalid statements: ${error instanceof Error ? error.message : String(error)}\n`
        )
      );
      return;
    }
  } else {
    console.log(chalk.dim('Paste IAM policy statements as a JSON array.'));
    console.log(chalk.dim('Example:\n'));
    console.log(chalk.dim(TEMPLATE_STATEMENTS));
    console.log();

    const raw = await input({
      message: 'Statements JSON:',
    });

    try {
      statements = parseStatements(raw);
    } catch (error) {
      console.log(
        chalk.red(
          `\nInvalid statements: ${error instanceof Error ? error.message : String(error)}\n`
        )
      );
      return;
    }
  }

  const description = await input({
    message: 'Description (optional):',
  });

  // Show summary
  console.log(chalk.dim('\nProfile summary:'));
  console.log(chalk.dim(`  Name:       ${name}`));
  console.log(chalk.dim(`  Statements: ${statements.length}`));
  if (description) console.log(chalk.dim(`  Desc:       ${description}`));
  console.log();

  const action = await select({
    message: 'What would you like to do?',
    choices: [
      { value: 'save', name: 'Save profile' },
      { value: 'cancel', name: 'Cancel' },
    ],
  });

  if (action === 'cancel') {
    console.log(chalk.yellow('\nCancelled.\n'));
    return;
  }

  const spinner = ora('Creating permissions profile...').start();
  await createPermissionsProfile(name, statements, description || undefined);
  spinner.succeed(`Permissions profile '${name}' created.`);

  console.log(
    chalk.dim(`\nAttach to a workstation with: clawdult permissions attach <workstation> ${name}\n`)
  );
}
