import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import {
  checkProvisionerCredentials,
  getDefaultProfileName,
} from '../../services/aws-bootstrap/index.js';
import { loadGlobalConfig } from '../../services/config.js';
import { CLIError } from './errors.js';

/**
 * Ensures AWS credentials are configured for provisioning.
 * If not configured, offers to run the bootstrap wizard.
 * Exits the process if credentials cannot be configured.
 */
export async function requireAwsCredentials(): Promise<void> {
  const globalConfig = await loadGlobalConfig();
  const profileName = globalConfig.awsProfile ?? getDefaultProfileName();

  const credCheck = await checkProvisionerCredentials(profileName);
  if (credCheck.configured) {
    return; // Credentials are good
  }

  console.log(chalk.yellow('⚠️  AWS credentials not configured for provisioning\n'));
  console.log(chalk.dim(`  Issue: ${credCheck.message}\n`));

  const runBootstrap = await confirm({
    message: 'Would you like to run the AWS setup wizard now?',
    default: true,
  });

  if (runBootstrap) {
    console.log(chalk.dim('\nLaunching AWS setup wizard...\n'));
    // Dynamically import and execute the setup-admin command
    const { setupAdminCommand } = await import('../commands/setup-admin/index.js');
    await setupAdminCommand.parseAsync([
      'node',
      'clawdult',
      'setup-admin',
      '--profile',
      profileName,
    ]);

    // Re-load config after wizard (profile may have changed)
    const updatedConfig = await loadGlobalConfig();
    const updatedProfileName = updatedConfig.awsProfile ?? getDefaultProfileName();

    // Re-check credentials after bootstrap using the updated profile
    const recheck = await checkProvisionerCredentials(updatedProfileName);
    if (!recheck.configured) {
      throw new CLIError(
        'AWS credentials still not configured after bootstrap. Please complete the AWS setup and try again.'
      );
    }
    console.log(chalk.green('\n✓ AWS credentials configured successfully!\n'));
  } else {
    throw new CLIError(
      'AWS credentials are required for this operation. Run: clawdult setup-admin to set up credentials'
    );
  }
}
