import { Command } from 'commander';
import { select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { resolveInstance } from '../utils/instance-resolver.js';
import { requireAwsCredentials } from '../utils/require-aws.js';
import {
  listPermissionsProfiles,
  getPermissionsProfile,
  getPermissionsDescription,
} from '../../services/permissions-profiles.js';
import { attachCustomPermissions, detachCustomPermissions } from '../../services/iam.js';
import { setInstanceTag, deleteInstanceTag } from '../../services/ec2.js';

export const permissionsCommand = new Command('permissions')
  .description('Manage custom IAM permissions on workstations')
  .action(async () => {
    console.log(chalk.bold('\nWorkstation Permissions\n'));
    console.log(chalk.dim('Commands:'));
    console.log(
      chalk.dim('  clawdult permissions attach [workstation] [profile]  Attach permissions profile')
    );
    console.log(
      chalk.dim('  clawdult permissions detach [workstation]            Remove custom permissions')
    );
    console.log(
      chalk.dim('  clawdult permissions show [workstation]              Show attached permissions')
    );
    console.log();
  });

permissionsCommand
  .command('attach [workstation] [profile]')
  .description('Attach a permissions profile to a workstation')
  .option('-r, --region <region>', 'AWS region')
  .action(async (workstationName: string | undefined, profileName: string | undefined, options) => {
    await requireAwsCredentials();

    const instance = await resolveInstance({
      name: workstationName,
      region: options.region,
      filterStates: ['running', 'stopped'],
      selectMessage: 'Select workstation:',
    });

    // Select profile
    if (!profileName) {
      const profiles = await listPermissionsProfiles();
      if (profiles.length === 0) {
        console.log(chalk.red('\nNo permissions profiles found.'));
        console.log(chalk.dim('Create one with: clawdult profiles permissions create [name]\n'));
        return;
      }

      profileName = await select({
        message: 'Select permissions profile:',
        choices: profiles.map((p) => ({
          value: p.name,
          name: `${p.name} (${getPermissionsDescription(p)})`,
        })),
      });
    }

    const profile = await getPermissionsProfile(profileName);
    if (!profile) {
      console.log(chalk.red(`\nPermissions profile '${profileName}' not found.\n`));
      return;
    }

    console.log(chalk.bold('\nAttach Permissions\n'));
    console.log(chalk.dim(`  Workstation: ${instance.name} (${instance.instanceId})`));
    console.log(chalk.dim(`  Profile:     ${profile.name}`));
    console.log(chalk.dim(`  Statements:  ${profile.statements.length}`));
    if (profile.description) {
      console.log(chalk.dim(`  Description: ${profile.description}`));
    }
    console.log();

    const spinner = ora('Attaching custom IAM permissions...').start();
    await attachCustomPermissions(instance.name, instance.region, profile.statements);
    await setInstanceTag(
      instance.instanceId,
      instance.region,
      'clawdult:permissionsProfileName',
      profile.name
    );
    spinner.succeed('Custom permissions attached');

    console.log(chalk.green('\n✓ Permissions take effect immediately (no restart needed).\n'));
  });

permissionsCommand
  .command('detach [workstation]')
  .description('Remove custom permissions from a workstation')
  .option('-r, --region <region>', 'AWS region')
  .action(async (workstationName: string | undefined, options) => {
    await requireAwsCredentials();

    const instance = await resolveInstance({
      name: workstationName,
      region: options.region,
      filterStates: ['running', 'stopped'],
      selectMessage: 'Select workstation:',
    });

    if (!instance.permissionsProfileName) {
      console.log(
        chalk.dim(`\nWorkstation '${instance.name}' has no custom permissions attached.\n`)
      );
      return;
    }

    console.log(
      chalk.dim(`\nCurrent permissions profile: ${chalk.cyan(instance.permissionsProfileName)}\n`)
    );

    const confirmed = await confirm({
      message: `Remove custom permissions from '${instance.name}'?`,
      default: true,
    });

    if (!confirmed) {
      console.log(chalk.yellow('\nCancelled.\n'));
      return;
    }

    const spinner = ora('Detaching custom IAM permissions...').start();
    await detachCustomPermissions(instance.name, instance.region);
    await deleteInstanceTag(
      instance.instanceId,
      instance.region,
      'clawdult:permissionsProfileName'
    );
    spinner.succeed('Custom permissions removed');

    console.log(chalk.green('\n✓ Custom permissions detached.\n'));
  });

permissionsCommand
  .command('show [workstation]')
  .description('Show custom permissions attached to a workstation')
  .option('-r, --region <region>', 'AWS region')
  .action(async (workstationName: string | undefined, options) => {
    await requireAwsCredentials();

    const instance = await resolveInstance({
      name: workstationName,
      region: options.region,
      filterStates: ['running', 'stopped'],
      selectMessage: 'Select workstation:',
    });

    if (!instance.permissionsProfileName) {
      console.log(
        chalk.dim(`\nWorkstation '${instance.name}' has no custom permissions attached.\n`)
      );
      console.log(
        chalk.dim('Attach a profile with: clawdult permissions attach ' + instance.name + '\n')
      );
      return;
    }

    console.log(chalk.bold(`\nPermissions for ${chalk.cyan(instance.name)}\n`));
    console.log(chalk.dim(`  Profile: ${instance.permissionsProfileName}\n`));

    const profile = await getPermissionsProfile(instance.permissionsProfileName);
    if (profile) {
      if (profile.description) {
        console.log(chalk.dim(`  ${profile.description}\n`));
      }
      console.log(chalk.bold('Statements:\n'));
      console.log(JSON.stringify(profile.statements, null, 2));
    } else {
      console.log(
        chalk.yellow(
          `  Profile '${instance.permissionsProfileName}' not found locally.\n` +
            '  The IAM policy may still be active on AWS.\n'
        )
      );
    }
    console.log();
  });
