import chalk from 'chalk';
import ora from 'ora';
import { select } from '@inquirer/prompts';
import {
  checkJointBudgetExists,
  applyBudgetProfile,
  getJointBudgetName,
  getBudgetConsoleUrl,
} from '../../../services/aws-bootstrap/index.js';
import {
  listBudgetProfiles,
  getBudgetProfile,
  getBudgetDescription,
} from '../../../services/budget-profiles.js';
import { createProfileInteractive as createBudgetProfileInteractive } from '../profiles/budget.js';
import { clickableUrl } from '../../utils/terminal-link.js';

interface BootstrapOptions {
  profile?: string;
  region?: string;
  manual?: boolean;
  adminProfile?: string;
  skipBudget?: boolean;
  budgetLimit?: number;
  budgetEmail?: string;
}

export async function runBudgetSetup(
  profileName: string,
  _options: BootstrapOptions
): Promise<void> {
  console.log(chalk.dim('Setting up a joint spending limit for ALL clawdult workstations.'));
  console.log(
    chalk.dim('This creates an AWS Budget that monitors costs tagged with clawdult:managed.\n')
  );

  // Check existing AWS budget
  let spinner = ora('Checking current AWS budget status...').start();
  let existingBudget;
  try {
    existingBudget = await checkJointBudgetExists(profileName);
  } catch (error) {
    spinner.warn('Could not check existing budget (may need budget permissions)');
    console.log(chalk.dim(`Error: ${error instanceof Error ? error.message : String(error)}`));
    console.log(chalk.dim('\nYou can set up the budget manually in the AWS console:'));
    console.log(`  ${clickableUrl(getBudgetConsoleUrl())}\n`);
    return;
  }

  if (existingBudget.exists) {
    spinner.info(`Current AWS Budget: ${getJointBudgetName()}`);
    console.log(chalk.dim(`  Monthly limit: $${existingBudget.monthlyLimit}/month`));
    console.log(
      chalk.dim(`  Current spend: $${existingBudget.currentSpend?.toFixed(2) || '0.00'}`)
    );
    if (existingBudget.notificationEmail) {
      console.log(chalk.dim(`  Notifications: ${existingBudget.notificationEmail}`));
    }
    console.log();
  } else {
    spinner.info('No AWS budget configured');
    console.log();
  }

  // List existing budget profiles
  const budgetProfiles = await listBudgetProfiles();

  // Build choices based on available profiles
  type BudgetAction = 'skip' | 'create' | string;
  const choices: { value: BudgetAction; name: string }[] = [];

  if (budgetProfiles.length > 0) {
    for (const profile of budgetProfiles) {
      const desc = getBudgetDescription(profile);
      choices.push({
        value: profile.name,
        name: `${profile.name} - ${desc}`,
      });
    }
  }

  choices.push({ value: 'create', name: 'Create new budget profile' });
  choices.push({ value: 'skip', name: 'Skip budget setup' });

  const action = await select<BudgetAction>({
    message: 'Select a budget profile to apply:',
    choices,
  });

  if (action === 'skip') {
    console.log(chalk.dim('\nSkipping budget setup. You can set it up later with:'));
    console.log(chalk.dim('  clawdult budget create'));
    console.log(chalk.dim('  clawdult budget apply <name>\n'));
    return;
  }

  let selectedProfile;
  if (action === 'create') {
    selectedProfile = await createBudgetProfileInteractive();
    if (!selectedProfile) {
      return;
    }
  } else {
    selectedProfile = await getBudgetProfile(action);
    if (!selectedProfile) {
      console.log(chalk.red(`\nBudget profile '${action}' not found.\n`));
      return;
    }
  }

  // Apply the selected profile to AWS
  spinner = ora('Applying budget profile to AWS...').start();

  const result = await applyBudgetProfile(selectedProfile, profileName);

  if (result.success) {
    if (result.isUpdate) {
      spinner.succeed(`Budget updated: ${getJointBudgetName()}`);
    } else {
      spinner.succeed(`Budget created: ${getJointBudgetName()}`);
    }
    console.log(chalk.dim(`  Limit: $${selectedProfile.monthlyLimit}/month`));
    console.log(chalk.dim(`  Alerts at: ${selectedProfile.alertThresholds.join('%, ')}%`));
    console.log(chalk.dim(`  Notifications: ${selectedProfile.notificationEmail}`));
    console.log();
    console.log(
      chalk.green('✓') + ' You will receive email alerts when spending reaches thresholds.'
    );
  } else {
    spinner.fail(`Failed to apply budget profile: ${result.error}`);
    console.log(chalk.dim('\nYou can set up the budget manually in the AWS console:'));
    console.log(`  ${clickableUrl(getBudgetConsoleUrl())}\n`);
  }

  console.log();
}
