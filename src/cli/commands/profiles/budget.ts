import { Command } from 'commander';
import { input, confirm, select } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import {
  listBudgetProfiles,
  getBudgetProfile,
  createBudgetProfile,
  deleteBudgetProfile,
  saveBudgetProfile,
  getBudgetDescription,
  type BudgetProfile,
} from '../../../services/budget-profiles.js';
import {
  checkJointBudgetExists,
  applyBudgetProfile,
  getJointBudgetName,
  getBudgetConsoleUrl,
} from '../../../services/aws-bootstrap/index.js';
import { loadGlobalConfig } from '../../../services/config.js';
import { clickableUrl } from '../../utils/terminal-link.js';

export const budgetCommand = new Command('budget')
  .description('Manage budget profiles for spending limits')
  .action(async () => {
    // Default action: list profiles or offer to create one
    const profiles = await listBudgetProfiles();

    if (profiles.length === 0) {
      console.log(chalk.dim('\nNo budget profiles configured.\n'));
      const create = await confirm({
        message: 'Would you like to create one now?',
        default: true,
      });
      if (create) {
        await createProfileInteractive();
      }
      return;
    }

    console.log(chalk.bold('\nBudget Profiles:\n'));
    for (const profile of profiles) {
      const desc = getBudgetDescription(profile);
      console.log(`  ${chalk.cyan(profile.name)}`);
      console.log(chalk.dim(`    ${desc}`));
      if (profile.description) {
        console.log(chalk.dim(`    ${profile.description}`));
      }
    }
    console.log();
    console.log(chalk.dim('Commands:'));
    console.log(chalk.dim('  clawdult profiles budget create [name]  Create a new profile'));
    console.log(chalk.dim('  clawdult profiles budget edit <name>    Edit an existing profile'));
    console.log(chalk.dim('  clawdult profiles budget delete <name>  Delete a profile'));
    console.log(chalk.dim('  clawdult profiles budget apply <name>   Apply profile to AWS'));
    console.log(
      chalk.dim('  clawdult profiles budget status         Show current AWS budget status')
    );
    console.log();
  });

budgetCommand
  .command('list')
  .description('List all budget profiles')
  .action(async () => {
    const profiles = await listBudgetProfiles();

    if (profiles.length === 0) {
      console.log(chalk.dim('\nNo budget profiles configured.'));
      console.log(chalk.dim('Create one with: clawdult profiles budget create [name]\n'));
      return;
    }

    console.log(chalk.bold('\nBudget Profiles:\n'));
    for (const profile of profiles) {
      const desc = getBudgetDescription(profile);
      console.log(`  ${chalk.cyan(profile.name)}`);
      console.log(chalk.dim(`    ${desc}`));
      if (profile.description) {
        console.log(chalk.dim(`    ${profile.description}`));
      }
    }
    console.log();
  });

budgetCommand
  .command('create [name]')
  .description('Create a new budget profile')
  .action(async (providedName?: string) => {
    await createProfileInteractive(providedName);
  });

budgetCommand
  .command('edit <name>')
  .description('Edit an existing budget profile')
  .action(async (name: string) => {
    const profile = await getBudgetProfile(name);
    if (!profile) {
      console.log(chalk.red(`\nBudget profile '${name}' not found.\n`));
      return;
    }

    console.log(chalk.bold(`\nEditing budget profile: ${chalk.cyan(name)}\n`));
    console.log(chalk.dim('Press Enter to keep existing values.\n'));

    const monthlyLimitStr = await input({
      message: 'Monthly limit (USD):',
      default: profile.monthlyLimit.toString(),
      validate: (value) => {
        const num = parseFloat(value);
        if (isNaN(num) || num <= 0) {
          return 'Please enter a positive number';
        }
        return true;
      },
    });

    const notificationEmail = await input({
      message: 'Notification email:',
      default: profile.notificationEmail,
      validate: (value) => {
        if (!value.includes('@')) {
          return 'Please enter a valid email address';
        }
        return true;
      },
    });

    const thresholdsStr = await input({
      message: 'Alert thresholds (comma-separated percentages):',
      default: profile.alertThresholds.join(', '),
      validate: (value) => {
        const nums = value.split(',').map((s) => parseFloat(s.trim()));
        if (nums.some((n) => isNaN(n) || n < 0 || n > 100)) {
          return 'Please enter valid percentages between 0 and 100';
        }
        return true;
      },
    });

    const description = await input({
      message: 'Description (optional):',
      default: profile.description || '',
    });

    profile.monthlyLimit = parseFloat(monthlyLimitStr);
    profile.notificationEmail = notificationEmail;
    profile.alertThresholds = thresholdsStr
      .split(',')
      .map((s) => parseFloat(s.trim()))
      .sort((a, b) => a - b);
    profile.description = description || undefined;

    const spinner = ora('Saving budget profile...').start();
    await saveBudgetProfile(profile);
    spinner.succeed(`Budget profile '${name}' updated.`);

    console.log(
      chalk.dim(`\nTo apply this profile to AWS, run: clawdult profiles budget apply ${name}\n`)
    );
  });

budgetCommand
  .command('delete <name>')
  .description('Delete a budget profile')
  .action(async (name: string) => {
    const profile = await getBudgetProfile(name);
    if (!profile) {
      console.log(chalk.red(`\nBudget profile '${name}' not found.\n`));
      return;
    }

    const confirmed = await confirm({
      message: `Delete budget profile '${name}'? This cannot be undone.`,
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.yellow('\nCancelled.\n'));
      return;
    }

    const spinner = ora('Deleting budget profile...').start();
    await deleteBudgetProfile(name);
    spinner.succeed(`Budget profile '${name}' deleted.`);
    console.log();
  });

budgetCommand
  .command('apply <name>')
  .description('Apply a budget profile to the AWS budget')
  .action(async (name: string) => {
    const profile = await getBudgetProfile(name);
    if (!profile) {
      console.log(chalk.red(`\nBudget profile '${name}' not found.\n`));
      return;
    }

    console.log(chalk.bold(`\nApplying budget profile: ${chalk.cyan(name)}\n`));
    console.log(chalk.dim(`  Monthly limit: $${profile.monthlyLimit}`));
    console.log(chalk.dim(`  Notification email: ${profile.notificationEmail}`));
    console.log(chalk.dim(`  Alert thresholds: ${profile.alertThresholds.join('%, ')}%\n`));

    const globalConfig = await loadGlobalConfig();
    const awsProfile = globalConfig.awsProfile ?? 'clawdult';

    const spinner = ora('Applying budget profile to AWS...').start();
    const result = await applyBudgetProfile(profile, awsProfile);

    if (result.success) {
      if (result.isUpdate) {
        spinner.succeed(`Budget updated: ${getJointBudgetName()}`);
      } else {
        spinner.succeed(`Budget created: ${getJointBudgetName()}`);
      }
      console.log(chalk.green('\n✓ Budget profile applied successfully.\n'));
    } else {
      spinner.fail(`Failed to apply budget profile: ${result.error}`);
      console.log(chalk.dim('\nYou can set up the budget manually in the AWS console:'));
      console.log(`  ${clickableUrl(getBudgetConsoleUrl())}\n`);
    }
  });

budgetCommand
  .command('status')
  .description('Show current AWS budget status')
  .action(async () => {
    const globalConfig = await loadGlobalConfig();
    const awsProfile = globalConfig.awsProfile ?? 'clawdult';

    const spinner = ora('Checking AWS budget status...').start();

    try {
      const budgetInfo = await checkJointBudgetExists(awsProfile);

      if (!budgetInfo.exists) {
        spinner.info('No AWS budget configured');
        console.log(chalk.dim('\nCreate a budget profile and apply it:'));
        console.log(chalk.dim('  clawdult profiles budget create'));
        console.log(chalk.dim('  clawdult profiles budget apply <name>\n'));
        return;
      }

      spinner.succeed(`AWS Budget: ${budgetInfo.name}`);
      console.log();
      console.log(chalk.bold('Current Status:'));
      console.log(`  Monthly limit: ${chalk.cyan(`$${budgetInfo.monthlyLimit}`)}`);
      console.log(
        `  Current spend: ${chalk.cyan(`$${budgetInfo.currentSpend?.toFixed(2) || '0.00'}`)}`
      );
      if (budgetInfo.notificationEmail) {
        console.log(`  Notifications: ${chalk.cyan(budgetInfo.notificationEmail)}`);
      }

      // Calculate percentage
      if (budgetInfo.monthlyLimit && budgetInfo.currentSpend !== undefined) {
        const percentage = (budgetInfo.currentSpend / budgetInfo.monthlyLimit) * 100;
        const percentStr = percentage.toFixed(1);
        const color = percentage >= 100 ? chalk.red : percentage >= 80 ? chalk.yellow : chalk.green;
        console.log(`  Usage: ${color(`${percentStr}%`)}`);
      }

      console.log();
      console.log(chalk.dim(`View in AWS Console: ${clickableUrl(getBudgetConsoleUrl())}`));
      console.log();
    } catch (error) {
      spinner.fail('Failed to check budget status');
      console.log(chalk.dim(`Error: ${error instanceof Error ? error.message : String(error)}`));
      console.log(chalk.dim('\nYou may need budget permissions. View manually:'));
      console.log(`  ${clickableUrl(getBudgetConsoleUrl())}\n`);
    }
  });

async function createProfileInteractive(providedName?: string): Promise<BudgetProfile | null> {
  console.log(chalk.bold('\nCreate Budget Profile\n'));
  console.log(chalk.dim('A budget profile stores spending limit settings.'));
  console.log(chalk.dim('Apply it to AWS to set up budget alerts.\n'));

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
  const existing = await getBudgetProfile(name);
  if (existing) {
    console.log(
      chalk.yellow(
        `\nProfile '${name}' already exists. Use 'clawdult profiles budget edit ${name}' to modify it.\n`
      )
    );
    return null;
  }

  // Data collection loop (supports "start over")
  while (true) {
    const budgetChoice = await select({
      message: 'Monthly spending limit:',
      choices: [
        { value: '100', name: '$100/month' },
        { value: '500', name: '$500/month' },
        { value: '1000', name: '$1,000/month' },
        { value: '2000', name: '$2,000/month' },
        { value: 'custom', name: 'Enter custom amount' },
      ],
      default: '1000',
    });

    let monthlyLimit: number;
    if (budgetChoice === 'custom') {
      const limitStr = await input({
        message: 'Enter monthly spending limit (USD):',
        validate: (value) => {
          const num = parseFloat(value);
          if (isNaN(num) || num <= 0) {
            return 'Please enter a positive number';
          }
          return true;
        },
      });
      monthlyLimit = parseFloat(limitStr);
    } else {
      monthlyLimit = parseFloat(budgetChoice);
    }

    const notificationEmail = await input({
      message: 'Email for budget alerts:',
      validate: (value) => {
        if (!value.includes('@')) {
          return 'Please enter a valid email address';
        }
        return true;
      },
    });

    const description = await input({
      message: 'Description (optional):',
    });

    // Show summary and confirm
    console.log(chalk.dim('\nProfile summary:'));
    console.log(chalk.dim(`  Name:    ${name}`));
    console.log(chalk.dim(`  Limit:   $${monthlyLimit}/month`));
    console.log(chalk.dim(`  Email:   ${notificationEmail}`));
    console.log(chalk.dim(`  Alerts:  50%, 80%, 100%`));
    if (description) console.log(chalk.dim(`  Desc:    ${description}`));
    console.log();

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

    const spinner = ora('Creating budget profile...').start();

    const profile = await createBudgetProfile(
      name,
      monthlyLimit,
      notificationEmail,
      [50, 80, 100],
      description || undefined
    );

    spinner.succeed(`Budget profile '${name}' created.`);

    const desc = getBudgetDescription(profile);
    console.log(chalk.dim(`  ${desc}`));
    console.log();
    console.log(
      chalk.dim(`To apply this profile to AWS, run: clawdult profiles budget apply ${name}\n`)
    );

    return profile;
  }
}

// Export the interactive create function for use in setup-admin
export { createProfileInteractive };
