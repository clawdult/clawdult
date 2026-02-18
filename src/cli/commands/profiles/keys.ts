import { Command } from 'commander';
import { input, password, confirm, select } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import {
  listKeyProfiles,
  getKeyProfile,
  createKeyProfile,
  deleteKeyProfile,
  setProfileKey,
  getConfiguredKeysDescription,
  type KeyProfile,
} from '../../../services/key-profiles.js';

export const keysCommand = new Command('keys')
  .description('Manage API key profiles for workstations')
  .action(async () => {
    // Default action: list profiles or offer to create one
    const profiles = await listKeyProfiles();

    if (profiles.length === 0) {
      console.log(chalk.dim('\nNo key profiles configured.\n'));
      const create = await confirm({
        message: 'Would you like to create one now?',
        default: true,
      });
      if (create) {
        await createProfileInteractive();
      }
      return;
    }

    console.log(chalk.bold('\nAPI Key Profiles:\n'));
    for (const profile of profiles) {
      const keys = getConfiguredKeysDescription(profile);
      console.log(`  ${chalk.cyan(profile.name)}`);
      console.log(chalk.dim(`    Keys: ${keys}`));
      if (profile.description) {
        console.log(chalk.dim(`    ${profile.description}`));
      }
    }
    console.log();
    console.log(chalk.dim('Commands:'));
    console.log(chalk.dim('  clawdult profiles keys create <name>  Create a new profile'));
    console.log(chalk.dim('  clawdult profiles keys edit <name>    Edit an existing profile'));
    console.log(chalk.dim('  clawdult profiles keys delete <name>  Delete a profile'));
    console.log();
  });

keysCommand
  .command('list')
  .description('List all key profiles')
  .action(async () => {
    const profiles = await listKeyProfiles();

    if (profiles.length === 0) {
      console.log(chalk.dim('\nNo key profiles configured.'));
      console.log(chalk.dim('Create one with: clawdult profiles keys create <name>\n'));
      return;
    }

    console.log(chalk.bold('\nAPI Key Profiles:\n'));
    for (const profile of profiles) {
      const keys = getConfiguredKeysDescription(profile);
      console.log(`  ${chalk.cyan(profile.name)}`);
      console.log(chalk.dim(`    Keys: ${keys}`));
      if (profile.description) {
        console.log(chalk.dim(`    ${profile.description}`));
      }
    }
    console.log();
  });

keysCommand
  .command('create [name]')
  .description('Create a new key profile')
  .action(async (providedName?: string) => {
    await createProfileInteractive(providedName);
  });

keysCommand
  .command('edit <name>')
  .description('Edit an existing key profile')
  .action(async (name: string) => {
    const profile = await getKeyProfile(name);
    if (!profile) {
      console.log(chalk.red(`\nKey profile '${name}' not found.\n`));
      return;
    }

    console.log(chalk.bold(`\nEditing key profile: ${chalk.cyan(name)}\n`));
    console.log(chalk.dim('Leave blank to keep existing value, or enter new key.\n'));

    await promptAndSetKey(name, 'claude', 'Claude (Anthropic)', profile.hasClaudeKey);
    await promptAndSetKey(name, 'openai', 'OpenAI', profile.hasOpenaiKey);
    await promptAndSetKey(name, 'grok', 'Grok (xAI)', profile.hasGrokKey);
    await promptAndSetKey(name, 'gemini', 'Gemini (Google)', profile.hasGeminiKey);

    console.log(chalk.green('\n✓ Key profile updated.\n'));
  });

keysCommand
  .command('delete <name>')
  .description('Delete a key profile')
  .action(async (name: string) => {
    const profile = await getKeyProfile(name);
    if (!profile) {
      console.log(chalk.red(`\nKey profile '${name}' not found.\n`));
      return;
    }

    const confirmed = await confirm({
      message: `Delete key profile '${name}'? This cannot be undone.`,
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.yellow('\nCancelled.\n'));
      return;
    }

    const spinner = ora('Deleting key profile...').start();
    await deleteKeyProfile(name);
    spinner.succeed(`Key profile '${name}' deleted.`);
    console.log();
  });

async function createProfileInteractive(providedName?: string): Promise<KeyProfile | null> {
  console.log(chalk.bold('\nCreate API Key Profile\n'));
  console.log(chalk.dim('A key profile stores API keys for AI services.'));
  console.log(chalk.dim('You can use different profiles for different workstations.\n'));

  const name =
    providedName ||
    (await input({
      message: 'Profile name:',
      validate: (v) => {
        if (!v.trim()) return 'Name is required';
        if (!/^[a-zA-Z0-9-_]+$/.test(v))
          return 'Use only letters, numbers, hyphens, and underscores';
        return true;
      },
    }));

  // Check if profile already exists
  const existing = await getKeyProfile(name);
  if (existing) {
    console.log(
      chalk.yellow(
        `\nProfile '${name}' already exists. Use 'clawdult profiles keys edit ${name}' to modify it.\n`
      )
    );
    return null;
  }

  // Data collection loop (supports "start over")
  while (true) {
    const description = await input({
      message: 'Description (optional):',
    });

    console.log(chalk.dim('\nEnter API keys (leave blank to skip):\n'));

    let claudeKey: string | undefined;
    let claudeSetupToken: string | undefined;

    const hasClaudeSubscription = await confirm({
      message: 'Do you have a Claude Pro/Max subscription?',
      default: false,
    });

    if (hasClaudeSubscription) {
      console.log(
        chalk.cyan('\n  Run `claude setup-token` in your terminal and paste the result:\n')
      );
      const token = await password({
        message: 'Claude setup token:',
        mask: '*',
      });
      if (token.trim()) claudeSetupToken = token.trim();
    } else {
      const key = await password({
        message: 'Claude (Anthropic) API key:',
        mask: '*',
      });
      if (key.trim()) claudeKey = key.trim();
    }

    const openaiKey = await password({
      message: 'OpenAI API key:',
      mask: '*',
    });

    const grokKey = await password({
      message: 'Grok (xAI) API key:',
      mask: '*',
    });

    const geminiKey = await password({
      message: 'Gemini (Google) API key:',
      mask: '*',
    });

    // Show summary and confirm
    console.log(chalk.dim('\nProfile summary:'));
    console.log(chalk.dim(`  Name:    ${name}`));
    if (description) console.log(chalk.dim(`  Desc:    ${description}`));
    console.log(
      chalk.dim(
        `  Claude:  ${claudeSetupToken ? 'setup token' : claudeKey ? 'API key' : 'not set'}`
      )
    );
    console.log(chalk.dim(`  OpenAI:  ${openaiKey ? 'set' : 'not set'}`));
    console.log(chalk.dim(`  Grok:    ${grokKey ? 'set' : 'not set'}`));
    console.log(chalk.dim(`  Gemini:  ${geminiKey ? 'set' : 'not set'}\n`));

    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { value: 'save', name: 'Save profile' },
        { value: 'restart', name: 'Start over' },
        { value: 'cancel', name: 'Cancel' },
      ],
    });

    if (action === 'cancel') {
      console.log(chalk.yellow('\nCancelled.\n'));
      return null;
    }

    if (action === 'restart') {
      console.log(chalk.dim('\nStarting over...\n'));
      continue;
    }

    const spinner = ora('Creating key profile...').start();

    const profile = await createKeyProfile(
      name,
      {
        claude: claudeKey || undefined,
        claudeSetupToken: claudeSetupToken || undefined,
        openai: openaiKey || undefined,
        grok: grokKey || undefined,
        gemini: geminiKey || undefined,
      },
      description || undefined
    );

    spinner.succeed(`Key profile '${name}' created.`);

    const keys = getConfiguredKeysDescription(profile);
    console.log(chalk.dim(`  Configured keys: ${keys}`));
    console.log();

    return profile;
  }
}

async function promptAndSetKey(
  profileName: string,
  keyType: 'claude' | 'openai' | 'grok' | 'gemini',
  label: string,
  hasExisting: boolean
): Promise<void> {
  const status = hasExisting ? chalk.green('configured') : chalk.dim('not set');
  console.log(`${label}: ${status}`);

  const action = await select({
    message: `${label}:`,
    choices: hasExisting
      ? [
          { value: 'keep', name: 'Keep existing' },
          { value: 'update', name: 'Update key' },
          { value: 'remove', name: 'Remove key' },
        ]
      : [
          { value: 'skip', name: 'Skip (leave unset)' },
          { value: 'set', name: 'Set key' },
        ],
  });

  if (action === 'keep' || action === 'skip') {
    return;
  }

  if (action === 'remove') {
    const { removeProfileKey } = await import('../../../services/key-profiles.js');
    await removeProfileKey(profileName, keyType);
    console.log(chalk.dim(`  ${label} key removed.`));
    return;
  }

  const newKey = await password({
    message: `Enter ${label} API key:`,
    mask: '*',
  });

  if (newKey) {
    await setProfileKey(profileName, keyType, newKey);
    console.log(chalk.dim(`  ${label} key updated.`));
  }
}

// Export the interactive create function for use in create command
export { createProfileInteractive };
