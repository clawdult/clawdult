import { Command } from 'commander';
import { input, confirm, select } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import YAML from 'yaml';
import {
  listAgentSpecs,
  getAgentSpec,
  saveAgentSpec,
  deleteAgentSpec,
} from '../../services/agent-specs.js';
import { listWorkstationTypes } from '../../services/workstation-types.js';
import { listKeyProfiles } from '../../services/key-profiles.js';
import { listConnectivityProfiles } from '../../services/connectivity-profiles.js';
import { listAgentAccounts } from '../../services/github-agent.js';
import type { AgentSpec } from '../../schemas/config.js';

export const specsCommand = new Command('specs')
  .description('Manage agent spec files for reproducible provisioning')
  .action(async () => {
    const specs = await listAgentSpecs();

    if (specs.length === 0) {
      console.log(chalk.dim('\nNo agent specs saved.\n'));
      console.log(chalk.dim('Create one with: clawdult specs create\n'));
      return;
    }

    console.log(chalk.bold('\nAgent Specs:\n'));
    for (const spec of specs) {
      console.log(`  ${chalk.cyan(spec.name)} - type: ${spec.workstationType}`);
    }
    console.log();
  });

specsCommand
  .command('list')
  .description('List saved agent specs')
  .action(async () => {
    const specs = await listAgentSpecs();

    if (specs.length === 0) {
      console.log(chalk.dim('\nNo agent specs saved.\n'));
      return;
    }

    console.log(chalk.bold('\nAgent Specs:\n'));
    for (const spec of specs) {
      const parts = [spec.workstationType];
      if (spec.keyProfile) parts.push(`keys: ${spec.keyProfile}`);
      if (spec.connectivityProfile) parts.push(`connectivity: ${spec.connectivityProfile}`);
      if (spec.github) parts.push(`github: ${spec.github}`);
      if (spec.instructions?.purpose) parts.push(`purpose: ${spec.instructions.purpose}`);
      console.log(`  ${chalk.cyan(spec.name)}`);
      console.log(chalk.dim(`    ${parts.join(', ')}`));
    }
    console.log();
  });

specsCommand
  .command('show <name>')
  .description('Display full spec as YAML')
  .action(async (name: string) => {
    const spec = await getAgentSpec(name);
    if (!spec) {
      console.log(chalk.red(`\nSpec '${name}' not found.\n`));
      return;
    }

    console.log(chalk.bold(`\nSpec: ${name}\n`));
    console.log(YAML.stringify(spec));
  });

specsCommand
  .command('create')
  .description('Create a new agent spec interactively')
  .action(async () => {
    console.log(chalk.bold('\nCreate Agent Spec\n'));
    console.log(chalk.dim('Define a reproducible agent configuration.\n'));

    const name = await input({
      message: 'Spec name:',
      validate: (v) => {
        if (!v.trim()) return 'Name is required';
        if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(v))
          return 'Lowercase alphanumeric with hyphens, must start/end with letter/number';
        return true;
      },
    });

    const existing = await getAgentSpec(name);
    if (existing) {
      const overwrite = await confirm({
        message: `Spec '${name}' already exists. Overwrite?`,
        default: false,
      });
      if (!overwrite) {
        console.log(chalk.yellow('\nCancelled.\n'));
        return;
      }
    }

    // Workstation type
    const types = await listWorkstationTypes();
    const workstationType = await select({
      message: 'Workstation type:',
      choices: types.map((t) => ({
        value: t.name,
        name: `${t.name} - ${t.description}`,
      })),
    });

    // Key profile (optional)
    const keyProfiles = await listKeyProfiles();
    let keyProfile: string | undefined;
    if (keyProfiles.length > 0) {
      const keyChoice = await select({
        message: 'Key profile:',
        choices: [
          { value: '__none__', name: 'None' },
          ...keyProfiles.map((p) => ({ value: p.name, name: p.name })),
        ],
      });
      if (keyChoice !== '__none__') keyProfile = keyChoice;
    }

    // Connectivity profile (optional)
    const connProfiles = await listConnectivityProfiles();
    let connectivityProfile: string | undefined;
    if (connProfiles.length > 0) {
      const connChoice = await select({
        message: 'Connectivity profile:',
        choices: [
          { value: '__none__', name: 'None' },
          ...connProfiles.map((p) => ({ value: p.name, name: p.name })),
        ],
      });
      if (connChoice !== '__none__') connectivityProfile = connChoice;
    }

    // GitHub agent (optional)
    const ghAccounts = await listAgentAccounts();
    let github: string | undefined;
    if (ghAccounts.length > 0) {
      const ghChoice = await select({
        message: 'GitHub agent account:',
        choices: [
          { value: '__none__', name: 'None' },
          ...ghAccounts.map((a) => ({ value: a.username, name: `${a.username} (${a.email})` })),
        ],
      });
      if (ghChoice !== '__none__') github = ghChoice;
    }

    // Purpose (optional)
    const purpose = await input({ message: 'Agent purpose (optional):' });

    // Repos (optional)
    const reposInput = await input({
      message: 'Repos to clone (comma-separated owner/repo, optional):',
    });
    const repos = reposInput
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
      .map((url) => ({ url }));

    const spec: AgentSpec = {
      name,
      workstationType,
      ...(keyProfile ? { keyProfile } : {}),
      ...(connectivityProfile ? { connectivityProfile } : {}),
      ...(github ? { github } : {}),
      ...(purpose || repos.length > 0
        ? {
            instructions: {
              ...(purpose ? { purpose } : {}),
              repos,
              cron: [],
            },
          }
        : {}),
    };

    console.log(chalk.dim('\nSpec preview:\n'));
    console.log(YAML.stringify(spec));

    const action = await select({
      message: 'Save this spec?',
      choices: [
        { value: 'save', name: 'Save' },
        { value: 'cancel', name: 'Cancel' },
      ],
    });

    if (action === 'cancel') {
      console.log(chalk.yellow('\nCancelled.\n'));
      return;
    }

    const spinner = ora('Saving spec...').start();
    await saveAgentSpec(spec);
    spinner.succeed(`Spec '${name}' saved.`);
    console.log(chalk.dim(`\nProvision with: clawdult create --spec ${name}\n`));
  });

specsCommand
  .command('delete <name>')
  .description('Delete a saved agent spec')
  .action(async (name: string) => {
    const spec = await getAgentSpec(name);
    if (!spec) {
      console.log(chalk.red(`\nSpec '${name}' not found.\n`));
      return;
    }

    const confirmed = await confirm({
      message: `Delete spec '${name}'?`,
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.yellow('\nCancelled.\n'));
      return;
    }

    const spinner = ora('Deleting spec...').start();
    await deleteAgentSpec(name);
    spinner.succeed(`Spec '${name}' deleted.`);
    console.log();
  });
