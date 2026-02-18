import chalk from 'chalk';
import ora from 'ora';
import { select, confirm, input } from '@inquirer/prompts';
import {
  checkAwsCliInstalled,
  checkPolicyExists,
  checkUserExists,
  createProvisionerPolicy,
  updateProvisionerPolicy,
  createClawdultUser,
  attachPolicyToUser,
  createAccessKeys,
  getExistingAccessKeys,
  deleteAccessKey,
  configureAwsProfile,
  verifyCredentials,
  loadProvisionerPolicy,
  getConsoleUrls,
  getIamUserName,
  getPolicyName,
  getAwsPolicyDocument,
  comparePolicies,
} from '../../../services/aws-bootstrap/index.js';
import { clickableUrl } from '../../utils/terminal-link.js';
import { openUrl, copyToClipboard } from './ami-builder.js';

export async function runAutomatedSetup(
  adminProfile: string | undefined,
  profileName: string,
  region: string
): Promise<void> {
  // Step 1: Create or update policy
  let spinner = ora('Checking ClawdultProvisioner policy...').start();

  // Check if policy exists
  let policyArn = await checkPolicyExists(adminProfile);
  if (policyArn) {
    spinner.text = 'Updating ClawdultProvisioner policy...';
    const updateResult = await updateProvisionerPolicy(policyArn, adminProfile);
    if (updateResult.success) {
      spinner.succeed(`Policy updated: ${policyArn}`);
    } else {
      spinner.fail(`Failed to update policy: ${updateResult.error}`);
      console.log(chalk.yellow('\nFalling back to manual mode for remaining steps.\n'));
      await runManualSetup(profileName, region, checkAwsCliInstalled(), policyArn);
      return;
    }
  } else {
    const policyResult = await createProvisionerPolicy(adminProfile);
    if (policyResult.success && policyResult.policyArn) {
      policyArn = policyResult.policyArn;
      spinner.succeed(`Policy created: ${policyArn}`);
    } else {
      spinner.fail(`Failed to create policy: ${policyResult.error}`);
      console.log(chalk.yellow('\nFalling back to manual mode for remaining steps.\n'));
      await runManualSetup(profileName, region, checkAwsCliInstalled());
      return;
    }
  }

  // Step 2: Create user
  spinner = ora('Creating clawdult-local user...').start();

  const existingUserArn = await checkUserExists(adminProfile);
  let userArn: string | undefined;

  if (existingUserArn) {
    userArn = existingUserArn;
    spinner.info(`User already exists: ${userArn}`);
  } else {
    const userResult = await createClawdultUser(adminProfile);
    if (userResult.success && userResult.userArn) {
      userArn = userResult.userArn;
      spinner.succeed(`User created: ${userArn}`);
    } else {
      spinner.fail(`Failed to create user: ${userResult.error}`);
      return;
    }
  }

  // Step 3: Attach policy
  spinner = ora('Attaching policy to user...').start();

  if (policyArn) {
    const attachResult = await attachPolicyToUser(policyArn, adminProfile);
    if (attachResult.success) {
      spinner.succeed('Policy attached to user');
    } else {
      spinner.fail(`Failed to attach policy: ${attachResult.error}`);
      return;
    }
  }

  // Step 4: Create access keys
  spinner = ora('Creating access keys...').start();

  // Check existing keys
  const existingKeys = await getExistingAccessKeys(adminProfile);
  if (existingKeys.length >= 2) {
    spinner.warn('User already has 2 access keys (maximum)');

    const deleteOld = await confirm({
      message: 'Delete an existing key to create a new one?',
      default: true,
    });

    if (deleteOld) {
      const keyToDelete = await select({
        message: 'Select key to delete:',
        choices: existingKeys.map((k) => ({ value: k, name: k })),
      });

      const deleted = await deleteAccessKey(keyToDelete, adminProfile);
      if (!deleted) {
        console.log(chalk.red('Failed to delete key'));
        return;
      }
      console.log(chalk.dim(`Deleted key: ${keyToDelete}`));
    } else {
      console.log(chalk.yellow('\nCannot create new keys without deleting an existing one.'));
      return;
    }
  }

  const keysResult = await createAccessKeys(adminProfile);
  if (!keysResult.success || !keysResult.credentials) {
    spinner.fail(`Failed to create access keys: ${keysResult.error}`);
    return;
  }

  spinner.succeed('Access keys created');

  // Display credentials (IMPORTANT: Only shown once!)
  console.log(
    chalk.bold.yellow('\n┌──────────────────────────────────────────────────────────────┐')
  );
  console.log(
    chalk.bold.yellow('│  IMPORTANT: Save these credentials! They are shown only once │')
  );
  console.log(
    chalk.bold.yellow('└──────────────────────────────────────────────────────────────┘')
  );
  console.log();
  console.log(chalk.bold('Access Key ID:     ') + chalk.cyan(keysResult.credentials.accessKeyId));
  console.log(
    chalk.bold('Secret Access Key: ') + chalk.cyan(keysResult.credentials.secretAccessKey)
  );
  console.log();

  // Step 5: Configure profile
  spinner = ora(`Configuring AWS CLI profile '${profileName}'...`).start();

  if (!checkAwsCliInstalled()) {
    spinner.warn('AWS CLI not installed - cannot configure profile automatically');
    console.log(chalk.dim('\nManually configure your credentials:'));
    console.log(chalk.dim(`  aws configure --profile ${profileName}`));
    return;
  }

  const configured = configureAwsProfile(keysResult.credentials, profileName, region);
  if (configured) {
    spinner.succeed(`AWS CLI profile '${profileName}' configured`);
  } else {
    spinner.fail('Failed to configure AWS CLI profile');
    console.log(chalk.dim('\nManually run:'));
    console.log(chalk.dim(`  aws configure --profile ${profileName}`));
  }
}

export async function runManualSetup(
  profileName: string,
  region: string,
  hasAwsCli: boolean,
  existingPolicyArn?: string
): Promise<void> {
  const urls = getConsoleUrls();
  const policy = await loadProvisionerPolicy();
  const policyJson = JSON.stringify(policy, null, 2);

  // Step functions return true to advance, false to go back
  async function step1Policy(): Promise<boolean> {
    if (existingPolicyArn) {
      console.log(chalk.bold('[1/4] Update IAM Policy'));
      console.log(chalk.dim('─'.repeat(50)));

      copyToClipboard(policyJson);
      console.log(chalk.green('✓ Policy JSON copied to clipboard!\n'));

      console.log(`Open the IAM Policy in the console:`);
      console.log(`  → ${clickableUrl(urls.editPolicy(existingPolicyArn))}\n`);
      console.log(`Steps:`);
      console.log(`  1. Click ${chalk.bold('"Edit"')} (or "Create new version" in Versions tab)`);
      console.log(`  2. Click the ${chalk.bold('"JSON"')} tab`);
      console.log(`  3. ${chalk.green('Replace all')} with the policy in your clipboard`);
      console.log(`  4. Click ${chalk.bold('"Next"')}`);
      console.log(`  5. Click ${chalk.bold('"Save changes"')}\n`);
    } else {
      console.log(chalk.bold('[1/4] Create IAM Policy'));
      console.log(chalk.dim('─'.repeat(50)));

      copyToClipboard(policyJson);
      console.log(chalk.green('✓ Policy JSON copied to clipboard!\n'));

      console.log(`Open the IAM Policies console:`);
      console.log(`  → ${clickableUrl(urls.createPolicy)}\n`);
      console.log(`Steps:`);
      console.log(`  1. Click ${chalk.bold('"Create policy"')}`);
      console.log(`  2. Click the ${chalk.bold('"JSON"')} tab`);
      console.log(`  3. ${chalk.green('Paste')} the policy (already in your clipboard)`);
      console.log(`  4. Click ${chalk.bold('"Next"')}`);
      console.log(`  5. Name: ${chalk.yellow(getPolicyName())}`);
      console.log(`  6. Click ${chalk.bold('"Create policy"')}\n`);
    }

    const policyChoices = [
      { value: 'continue', name: 'Continue (I completed this step)' },
      { value: 'open', name: 'Open URL in browser' },
      { value: 'show', name: 'Show policy JSON' },
      { value: 'copy', name: 'Re-copy policy JSON to clipboard' },
    ];

    let action = await select({ message: 'Action:', choices: policyChoices });

    while (action !== 'continue') {
      if (action === 'open') {
        openUrl(existingPolicyArn ? urls.editPolicy(existingPolicyArn) : urls.createPolicy);
      } else if (action === 'show') {
        console.log(chalk.bold('\nPolicy JSON:'));
        console.log(chalk.dim('─'.repeat(50)));
        console.log(chalk.dim(policyJson));
        console.log(chalk.dim('─'.repeat(50)));
      } else if (action === 'copy') {
        copyToClipboard(policyJson);
        console.log(chalk.green('Copied to clipboard!'));
      }

      action = await select({ message: 'Action:', choices: policyChoices });
    }

    return true;
  }

  async function step2User(): Promise<boolean> {
    console.log(chalk.bold('\n[2/4] Create IAM User'));
    console.log(chalk.dim('─'.repeat(50)));
    console.log(`\nOpen the IAM Users console:`);
    console.log(`  → ${clickableUrl(urls.createUser)}\n`);
    console.log(`Steps:`);
    console.log(`  1. Click ${chalk.bold('"Create user"')}`);
    console.log(`  2. User name: ${chalk.yellow(getIamUserName())}`);
    console.log(`  3. Click ${chalk.bold('"Next"')}`);
    console.log(`  4. Select ${chalk.bold('"Attach policies directly"')}`);
    console.log(`  5. Search for ${chalk.yellow(getPolicyName())} and select it`);
    console.log(`  6. Click ${chalk.bold('"Next"')}`);
    console.log(`  7. Click ${chalk.bold('"Create user"')}\n`);

    const userChoices = [
      { value: 'continue', name: 'Continue (I completed this step)' },
      { value: 'open', name: 'Open URL in browser' },
      { value: '__back__', name: '<< Go back' },
    ];

    let action = await select({ message: 'Action:', choices: userChoices });

    while (action !== 'continue' && action !== '__back__') {
      if (action === 'open') {
        openUrl(urls.createUser);
      }
      action = await select({ message: 'Action:', choices: userChoices });
    }

    return action !== '__back__';
  }

  async function step3Keys(): Promise<boolean> {
    const securityUrl = urls.securityCredentials(getIamUserName());

    console.log(chalk.bold('\n[3/4] Create Access Keys'));
    console.log(chalk.dim('─'.repeat(50)));
    console.log(`\nOpen the user's Security credentials tab:`);
    console.log(`  → ${clickableUrl(securityUrl)}\n`);
    console.log(`Steps:`);
    console.log(`  1. Scroll down to ${chalk.bold('"Access keys"')}`);
    console.log(`  2. Click ${chalk.bold('"Create access key"')}`);
    console.log(`  3. Select ${chalk.bold('"Command Line Interface (CLI)"')}`);
    console.log(`  4. Check the confirmation box and click ${chalk.bold('"Next"')}`);
    console.log(`  5. Click ${chalk.bold('"Create access key"')}`);
    console.log(`  6. ${chalk.yellow.bold('Copy both the Access Key ID and Secret Access Key')}\n`);

    const keysChoices = [
      { value: 'continue', name: 'Continue (I have the keys)' },
      { value: 'open', name: 'Open URL in browser' },
      { value: '__back__', name: '<< Go back' },
    ];

    let action = await select({ message: 'Action:', choices: keysChoices });

    while (action !== 'continue' && action !== '__back__') {
      if (action === 'open') {
        openUrl(securityUrl);
      }
      action = await select({ message: 'Action:', choices: keysChoices });
    }

    return action !== '__back__';
  }

  async function step4Configure(): Promise<boolean> {
    console.log(chalk.bold('\n[4/4] Configure AWS CLI Profile'));
    console.log(chalk.dim('─'.repeat(50)));

    const goBackChoice = await select({
      message: 'Action:',
      choices: [
        { value: 'continue', name: 'Enter credentials' },
        { value: '__back__', name: '<< Go back' },
      ],
    });

    if (goBackChoice === '__back__') return false;

    const accessKeyId = await input({
      message: 'Enter Access Key ID:',
      validate: (value) => value.length === 20 || 'Access Key ID should be 20 characters',
    });

    const secretAccessKey = await input({
      message: 'Enter Secret Access Key:',
      validate: (value) => value.length === 40 || 'Secret Access Key should be 40 characters',
    });

    if (hasAwsCli) {
      const spinner = ora(`Configuring AWS CLI profile '${profileName}'...`).start();

      const configured = configureAwsProfile({ accessKeyId, secretAccessKey }, profileName, region);

      if (configured) {
        spinner.succeed(`AWS CLI profile '${profileName}' configured`);
      } else {
        spinner.fail('Failed to configure profile');
        console.log(chalk.dim('\nManually run:'));
        console.log(chalk.dim(`  aws configure --profile ${profileName}`));
      }
    } else {
      console.log(chalk.yellow('\nAWS CLI not installed. Save these credentials securely.'));
      console.log(chalk.dim('When you install AWS CLI, run:'));
      console.log(chalk.dim(`  aws configure --profile ${profileName}`));
    }

    return true;
  }

  // Step loop with back navigation
  const manualSteps = [step1Policy, step2User, step3Keys, step4Configure];
  let stepIndex = 0;
  while (stepIndex < manualSteps.length) {
    if (await manualSteps[stepIndex]()) {
      stepIndex++;
    } else {
      stepIndex = Math.max(0, stepIndex - 1);
    }
  }
}

export async function runPolicyUpdateStep(profile?: string): Promise<void> {
  const localPolicy = await loadProvisionerPolicy();
  const policyJson = JSON.stringify(localPolicy, null, 2);
  const policyName = getPolicyName();
  const policyUrl = `https://console.aws.amazon.com/iam/home#/policies?search=${encodeURIComponent(policyName)}`;

  // Try to auto-detect if policy differs from AWS
  const policyArn = await checkPolicyExists(profile);
  if (policyArn) {
    const awsPolicy = await getAwsPolicyDocument(policyArn, profile);
    if (awsPolicy) {
      const { identical } = comparePolicies(localPolicy, awsPolicy);
      if (identical) {
        console.log(chalk.green('✓') + ' Policy is up to date\n');
        return;
      }
      console.log(chalk.yellow('!') + ' Local policy differs from AWS\n');
    } else {
      console.log(
        chalk.yellow('!') +
          ' Could not fetch AWS policy to compare (may lack iam:GetPolicyVersion permission)\n'
      );
    }
  }

  // Policy differs or we couldn't check - show manual update flow
  // Auto-copy policy JSON to clipboard
  copyToClipboard(policyJson);
  console.log(chalk.green('✓ Policy JSON copied to clipboard!\n'));

  console.log(`Open the IAM Policy in the console:`);
  console.log(`  → ${clickableUrl(policyUrl)}\n`);
  console.log(`Steps:`);
  console.log(`  1. Click on ${chalk.yellow(policyName)}`);
  console.log(`  2. Click ${chalk.bold('"Edit"')}`);
  console.log(`  3. Click the ${chalk.bold('"JSON"')} tab`);
  console.log(`  4. ${chalk.green('Replace all')} with the policy in your clipboard`);
  console.log(`  5. Click ${chalk.bold('"Next"')}`);
  console.log(`  6. Click ${chalk.bold('"Save changes"')}\n`);

  let action = await select({
    message: 'Action:',
    choices: [
      { value: 'continue', name: 'Continue (I updated the policy)' },
      { value: 'skip', name: 'Skip (policy is already up to date)' },
      { value: 'open', name: 'Open URL in browser' },
      { value: 'show', name: 'Show policy JSON' },
      { value: 'copy', name: 'Re-copy policy JSON to clipboard' },
    ],
  });

  while (action !== 'continue' && action !== 'skip') {
    if (action === 'open') {
      openUrl(policyUrl);
    } else if (action === 'show') {
      console.log(chalk.bold('\nPolicy JSON:'));
      console.log(chalk.dim('─'.repeat(50)));
      console.log(chalk.dim(policyJson));
      console.log(chalk.dim('─'.repeat(50)));
    } else if (action === 'copy') {
      copyToClipboard(policyJson);
      console.log(chalk.green('Copied to clipboard!'));
    }

    action = await select({
      message: 'Action:',
      choices: [
        { value: 'continue', name: 'Continue (I updated the policy)' },
        { value: 'skip', name: 'Skip (policy is already up to date)' },
        { value: 'open', name: 'Open URL in browser' },
        { value: 'show', name: 'Show policy JSON' },
        { value: 'copy', name: 'Re-copy policy JSON to clipboard' },
      ],
    });
  }

  if (action === 'continue') {
    console.log(chalk.green('✓') + ' Policy updated\n');
  } else {
    console.log(chalk.dim('Skipped policy update\n'));
  }
}

interface VerificationResults {
  identity: boolean;
  ec2Describe: boolean;
  iamList: boolean;
  success: boolean;
}

export async function runVerification(profileName: string): Promise<VerificationResults> {
  const spinner = ora('Verifying credentials...').start();

  const results = await verifyCredentials(profileName);

  spinner.stop();

  console.log(chalk.bold('Verification Results:'));
  console.log();

  if (results.identity) {
    console.log(chalk.green('✓') + ' STS GetCallerIdentity - Credentials are valid');
  } else {
    console.log(chalk.red('✗') + ' STS GetCallerIdentity - Failed');
  }

  if (results.ec2Describe) {
    console.log(chalk.green('✓') + ' EC2 access - Ready for provisioning');
  } else {
    console.log(chalk.red('✗') + ' EC2 access - Failed');
  }

  if (results.iamList) {
    console.log(chalk.green('✓') + ' IAM permissions - Ready for provisioning');
  } else {
    console.log(
      chalk.yellow('!') + ' IAM permissions - Limited (may still work for clawdult-* resources)'
    );
  }

  console.log();

  const success = results.identity && results.ec2Describe;

  if (success) {
    console.log(chalk.green.bold('✓ AWS credentials verified!'));
  } else {
    console.log(chalk.yellow('! Some verifications failed. Check your credentials and try again.'));
  }

  console.log();

  return {
    identity: results.identity,
    ec2Describe: results.ec2Describe,
    iamList: results.iamList,
    success,
  };
}
