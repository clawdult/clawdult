import { Command } from 'commander';
import { input, confirm, checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import {
  listWorkstationTypes,
  getWorkstationType,
  isBuiltinType,
  saveCustomType,
  deleteCustomType,
} from '../../../services/workstation-types.js';
import { CapabilityModuleSchema, ToolsConfigSchema } from '../../../schemas/config.js';
import type { WorkstationType } from '../../../schemas/config.js';

export const typesCommand = new Command('types')
  .description('Manage workstation types')
  .action(async () => {
    const types = await listWorkstationTypes();

    if (types.length === 0) {
      console.log(chalk.dim('\nNo workstation types configured.\n'));
      return;
    }

    console.log(chalk.bold('\nWorkstation Types:\n'));
    for (const t of types) {
      const label = isBuiltinType(t.name) ? chalk.dim('(built-in)') : chalk.cyan('(custom)');
      const caps = t.capabilities.length > 0 ? chalk.dim(` [${t.capabilities.join(', ')}]`) : '';
      console.log(`  ${chalk.cyan(t.name)} ${label} - ${t.description}${caps}`);
    }
    console.log();
  });

typesCommand
  .command('list')
  .description('List all workstation types')
  .action(async () => {
    const types = await listWorkstationTypes();

    console.log(chalk.bold('\nWorkstation Types:\n'));
    for (const t of types) {
      const label = isBuiltinType(t.name) ? chalk.dim('(built-in)') : chalk.cyan('(custom)');
      const caps = t.capabilities.length > 0 ? chalk.dim(` [${t.capabilities.join(', ')}]`) : '';
      const tools = Object.entries(t.tools)
        .filter(([, v]) => v)
        .map(([k]) => k);
      console.log(`  ${chalk.cyan(t.name)} ${label}`);
      console.log(chalk.dim(`    ${t.description}${caps}`));
      console.log(chalk.dim(`    Tools: ${tools.join(', ')}`));
    }
    console.log();
  });

typesCommand
  .command('show <name>')
  .description('Show workstation type details')
  .action(async (name: string) => {
    const t = await getWorkstationType(name);
    if (!t) {
      console.log(chalk.red(`\nWorkstation type '${name}' not found.\n`));
      return;
    }

    const label = isBuiltinType(t.name) ? '(built-in)' : '(custom)';
    console.log(chalk.bold(`\n${t.name} ${chalk.dim(label)}\n`));
    console.log(`  Description:  ${t.description}`);
    console.log(
      `  Capabilities: ${t.capabilities.length > 0 ? t.capabilities.join(', ') : 'none'}`
    );
    console.log(`  Tools:`);
    for (const [tool, enabled] of Object.entries(t.tools)) {
      console.log(`    ${enabled ? chalk.green('✓') : chalk.dim('✗')} ${tool}`);
    }
    console.log();
  });

typesCommand
  .command('create [name]')
  .description('Create a custom workstation type')
  .action(async (providedName?: string) => {
    console.log(chalk.bold('\nCreate Custom Workstation Type\n'));

    const name =
      providedName ||
      (await input({
        message: 'Type name:',
        validate: (v) => {
          if (!v.trim()) return 'Name is required';
          if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(v))
            return 'Lowercase alphanumeric with hyphens, must start with letter';
          return true;
        },
      }));

    const existing = await getWorkstationType(name);
    if (existing && isBuiltinType(name)) {
      console.log(
        chalk.yellow(`\n'${name}' is a built-in type. Your custom type will override it.\n`)
      );
    } else if (existing) {
      const overwrite = await confirm({
        message: `Custom type '${name}' already exists. Overwrite?`,
        default: false,
      });
      if (!overwrite) {
        console.log(chalk.yellow('\nCancelled.\n'));
        return;
      }
    }

    const description = await input({
      message: 'Description:',
      validate: (v) => (v.trim() ? true : 'Description is required'),
    });

    const capabilityOptions = CapabilityModuleSchema.options;
    const capabilities = await checkbox({
      message: 'Select capabilities:',
      choices: capabilityOptions.map((c) => ({ value: c, name: c })),
    });

    const toolDefaults = ToolsConfigSchema.parse({});
    const toolKeys = Object.keys(toolDefaults) as (keyof typeof toolDefaults)[];

    const enabledTools = await checkbox({
      message: 'Select tools to enable:',
      choices: toolKeys.map((k) => ({
        value: k,
        name: k,
        checked: toolDefaults[k],
      })),
    });

    const tools: Record<string, boolean> = {};
    for (const k of toolKeys) {
      tools[k] = enabledTools.includes(k);
    }

    const wsType: WorkstationType = {
      name,
      description,
      capabilities,
      tools: tools as WorkstationType['tools'],
    };

    const spinner = ora('Saving workstation type...').start();
    await saveCustomType(wsType);
    spinner.succeed(`Workstation type '${name}' saved.`);
    console.log();
  });

typesCommand
  .command('delete <name>')
  .description('Delete a custom workstation type')
  .action(async (name: string) => {
    if (isBuiltinType(name)) {
      console.log(chalk.red(`\n'${name}' is a built-in type and cannot be deleted.\n`));
      return;
    }

    const existing = await getWorkstationType(name);
    if (!existing) {
      console.log(chalk.red(`\nWorkstation type '${name}' not found.\n`));
      return;
    }

    const confirmed = await confirm({
      message: `Delete custom workstation type '${name}'?`,
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.yellow('\nCancelled.\n'));
      return;
    }

    const spinner = ora('Deleting workstation type...').start();
    await deleteCustomType(name);
    spinner.succeed(`Workstation type '${name}' deleted.`);
    console.log();
  });
