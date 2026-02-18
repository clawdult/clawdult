import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { select, confirm, input } from '@inquirer/prompts';
import {
  checkAwsCliInstalled,
  getAwsCliVersion,
  installAwsCli,
  checkAwsAuth,
  checkIamPermissions,
  checkProfileExists,
  checkPolicyExists,
  getDefaultProfileName,
  getIamUserName,
  getPolicyName,
} from '../../../services/aws-bootstrap/index.js';
import { loadGlobalConfig, saveGlobalConfig } from '../../../services/config.js';
import { clickableUrl } from '../../utils/terminal-link.js';
import {
  runAutomatedSetup,
  runManualSetup,
  runPolicyUpdateStep,
  runVerification,
} from './credential-wizard.js';
import { runAmiBuildPhase } from './ami-builder.js';
import { runBudgetSetup } from './budget-wizard.js';

async function saveAwsProfileToConfig(profileName: string): Promise<void> {
  const config = await loadGlobalConfig();
  await saveGlobalConfig({ ...config, awsProfile: profileName });
}

interface BootstrapOptions {
  profile?: string;
  region?: string;
  manual?: boolean;
  adminProfile?: string;
  skipBudget?: boolean;
  budgetLimit?: number;
  budgetEmail?: string;
}

export const setupAdminCommand = new Command('setup-admin')
  .description('Set up AWS IAM policy and user for Clawdult provisioning')
  .option('--profile <name>', 'AWS profile name to create', getDefaultProfileName())
  .option('--region <region>', 'Default AWS region', 'us-east-1')
  .option('--manual', 'Force guided manual mode (no automated AWS API calls)')
  .option('--admin-profile <name>', 'Existing AWS profile with IAM admin permissions')
  .option('--skip-budget', 'Skip spending limit budget setup')
  .option('--budget-limit <amount>', 'Monthly spending limit in USD (default: 1000)', parseInt)
  .option('--budget-email <email>', 'Email address for budget alerts')
  .action(async (options: BootstrapOptions) => {
    console.log(chalk.bold('\n┌──────────────────────────────────────────────────────────────┐'));
    console.log(chalk.bold('│              AWS BOOTSTRAP WIZARD                            │'));
    console.log(chalk.bold('│         Set up AWS credentials for Clawdult                  │'));
    console.log(chalk.bold('└──────────────────────────────────────────────────────────────┘\n'));

    console.log(
      chalk.yellow('💡 Tip:') +
        ' Consider using a prepaid or virtual credit card (e.g. ' +
        clickableUrl('https://privacy.com') +
        ')'
    );
    console.log(
      chalk.dim(
        "   for your AWS billing. Set a spending limit on the card so you can't lose more than you're comfortable with.\n"
      )
    );

    const profileName = options.profile ?? getDefaultProfileName();
    const region = options.region ?? 'us-east-1';

    // Phase 1: Prerequisites
    console.log(chalk.bold.blue('Phase 1: Checking Prerequisites\n'));

    // Check AWS CLI
    let hasAwsCli = checkAwsCliInstalled();
    if (hasAwsCli) {
      const version = getAwsCliVersion();
      console.log(chalk.green('✓') + ` AWS CLI installed: ${chalk.dim(version)}`);
    } else {
      console.log(chalk.yellow('!') + ' AWS CLI not installed');

      // Attempt automatic installation
      const installed = await installAwsCli();
      if (installed) {
        hasAwsCli = true;
        const version = getAwsCliVersion();
        console.log(chalk.green('✓') + ` AWS CLI installed: ${chalk.dim(version)}`);
      } else {
        console.log(chalk.red('✗') + ' Could not install AWS CLI automatically');
        console.log(chalk.dim('\nInstall manually:'));
        console.log(chalk.dim('  macOS: brew install awscli'));
        console.log(
          chalk.dim(
            '  Linux: curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"'
          )
        );
        console.log(chalk.dim('  Windows: https://aws.amazon.com/cli/\n'));

        if (!options.manual) {
          console.log(
            chalk.yellow(
              'Continuing in manual mode (AWS CLI required for profile configuration).\n'
            )
          );
          options.manual = true;
        }
      }
    }

    // Check existing credentials
    const adminProfile = options.adminProfile;
    let hasIamPermissions = false;
    let currentIdentity = null;

    if (!options.manual) {
      const spinner = ora('Checking AWS credentials...').start();

      if (adminProfile) {
        currentIdentity = await checkAwsAuth(adminProfile);
        if (currentIdentity) {
          spinner.succeed(`Using admin profile: ${adminProfile}`);
          console.log(chalk.dim(`  Account: ${currentIdentity.account}`));
          console.log(chalk.dim(`  Identity: ${currentIdentity.arn}`));
          hasIamPermissions = await checkIamPermissions(adminProfile);
        } else {
          spinner.fail(`Profile '${adminProfile}' not found or invalid`);
        }
      } else {
        currentIdentity = await checkAwsAuth();
        if (currentIdentity) {
          spinner.succeed('Found default AWS credentials');
          console.log(chalk.dim(`  Account: ${currentIdentity.account}`));
          console.log(chalk.dim(`  Identity: ${currentIdentity.arn}`));
          hasIamPermissions = await checkIamPermissions();
        } else {
          spinner.info('No admin credentials found (use --admin-profile for automated IAM setup)');
        }
      }

      if (hasIamPermissions) {
        console.log(chalk.green('✓') + ' IAM permissions available for automated setup\n');
      } else if (currentIdentity) {
        console.log(
          chalk.yellow('!') + ' Limited IAM permissions - some steps may require manual setup\n'
        );
      }
    }

    // Check if target profile already exists
    if (await checkProfileExists(profileName)) {
      console.log(chalk.yellow(`! Profile '${profileName}' already exists`));

      const action = await select({
        message: 'What would you like to do?',
        choices: [
          { value: 'continue', name: 'Refresh setup with existing credentials' },
          { value: 'verify', name: 'Verify existing profile works' },
          { value: 'recreate', name: 'Recreate with new credentials' },
          { value: 'ami', name: 'Refresh AMI' },
          { value: 'rename', name: 'Use a different profile name' },
          { value: 'cancel', name: 'Cancel' },
        ],
      });

      if (action === 'cancel') {
        console.log(chalk.yellow('\nBootstrap cancelled.\n'));
        return;
      }

      if (action === 'verify') {
        const results = await runVerification(profileName);

        if (!results.success) {
          const remediation = await select({
            message: 'How would you like to proceed?',
            choices: [
              { value: 'setup', name: 'Re-run full setup with new credentials' },
              { value: 'policy', name: 'Update IAM policy' },
              { value: 'cancel', name: 'Exit without changes' },
            ],
          });

          if (remediation === 'setup') {
            // Continue with full setup flow - don't return
            console.log(chalk.dim('\nContinuing with full setup...\n'));
          } else if (remediation === 'policy') {
            console.log(chalk.bold.blue('\nPolicy Update\n'));
            await runPolicyUpdateStep(profileName);
            // Re-verify after policy update
            console.log(chalk.bold.blue('\nRe-verification\n'));
            await runVerification(profileName);
            return;
          } else {
            return;
          }
        } else {
          return;
        }
      }

      if (action === 'continue') {
        await saveAwsProfileToConfig(profileName);

        // Always offer to update policy - user can skip if already up to date
        console.log(chalk.bold.blue('\nPolicy Update\n'));
        await runPolicyUpdateStep(profileName);

        console.log(chalk.bold.blue('\nVerification\n'));
        await runVerification(profileName);

        if (!options.skipBudget) {
          console.log(chalk.bold.blue('\nSpending Limit Budget\n'));
          await runBudgetSetup(profileName, options);
        }

        console.log(chalk.bold.blue('\nPhase 6: Build Clawdult AMI\n'));
        await runAmiBuildPhase(region, profileName);

        return;
      }

      if (action === 'ami') {
        console.log(chalk.bold.blue('\nRefresh AMI\n'));
        await saveAwsProfileToConfig(profileName);
        await runAmiBuildPhase(region, profileName);
        return;
      }

      if (action === 'rename') {
        const newName = await input({
          message: 'Enter new profile name:',
          default: `${profileName}-new`,
        });
        console.log(chalk.dim(`\nUsing profile name: ${newName}\n`));
        // Continue with the new profile name
        options.profile = newName;
        // Fall through to continue with setup
      }
    }

    // Use the final profile name (may have been changed)
    const finalProfileName = options.profile ?? getDefaultProfileName();
    await saveAwsProfileToConfig(finalProfileName);

    // Display what the wizard will do
    console.log(chalk.bold('This wizard will:'));
    console.log(chalk.dim(`  1. Create IAM policy: ${getPolicyName()}`));
    console.log(chalk.dim(`  2. Create IAM user: ${getIamUserName()}`));
    console.log(chalk.dim(`  3. Attach policy to user`));
    console.log(chalk.dim(`  4. Create access keys`));
    console.log(chalk.dim(`  5. Configure AWS CLI profile: ${finalProfileName}\n`));

    const proceed = await confirm({
      message: 'Continue with AWS bootstrap?',
      default: true,
    });

    if (!proceed) {
      console.log(chalk.yellow('\nBootstrap cancelled.\n'));
      return;
    }

    // Phase 2: Mode Selection
    console.log(chalk.bold.blue('\nPhase 2: Setup Mode\n'));

    let useAutomated = false;

    if (options.manual) {
      console.log(chalk.dim('Using manual mode as requested.\n'));
    } else if (hasIamPermissions) {
      const mode = await select({
        message: 'Choose setup mode:',
        choices: [
          { value: 'auto', name: 'Automated (recommended) - Create resources via AWS API' },
          { value: 'manual', name: 'Manual - Step-by-step console instructions' },
        ],
      });
      useAutomated = mode === 'auto';
    } else {
      console.log(chalk.dim('Using manual mode (no IAM permissions detected).\n'));
    }

    // Phase 3: Create Resources
    console.log(chalk.bold.blue('\nPhase 3: Create AWS Resources\n'));

    if (useAutomated) {
      await runAutomatedSetup(adminProfile, finalProfileName, region);
    } else {
      // Check if policy already exists (try using clawdult profile or admin profile)
      let existingPolicyArn: string | null = null;
      try {
        const profileForCheck =
          adminProfile ||
          ((await checkProfileExists(finalProfileName)) ? finalProfileName : undefined);
        existingPolicyArn = await checkPolicyExists(profileForCheck);
      } catch {
        // Ignore errors - we'll create a new policy if we can't check
      }
      await runManualSetup(finalProfileName, region, hasAwsCli, existingPolicyArn || undefined);
    }

    // Phase 4: Verification
    console.log(chalk.bold.blue('\nPhase 4: Verification\n'));
    await runVerification(finalProfileName);

    // Phase 5: Budget Setup (optional but recommended)
    if (!options.skipBudget) {
      console.log(chalk.bold.blue('\nPhase 5: Spending Limit Budget\n'));
      await runBudgetSetup(finalProfileName, options);
    }

    // Phase 6: Build Clawdult AMI
    console.log(chalk.bold.blue('\nPhase 6: Build Clawdult AMI\n'));
    await runAmiBuildPhase(region, finalProfileName);

    // Final success message
    console.log(chalk.green.bold('✓ AWS bootstrap complete!'));
    console.log(chalk.dim(`\nYou can now use: clawdult create <agent-name>`));
    console.log(chalk.dim(`AWS profile: ${finalProfileName}`));
    console.log(chalk.dim(`\nTo use this profile, set: export AWS_PROFILE=${finalProfileName}`));
    console.log();
  });
