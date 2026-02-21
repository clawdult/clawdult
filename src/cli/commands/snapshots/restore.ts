import { Command } from 'commander';
import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { WorkstationConfigSchema, InstanceTypeSchema } from '../../../schemas/config.js';
import {
  describeAmi,
  copyAmiToRegion,
  waitForAmiAvailable,
  launchInstance,
  waitForInstanceRunning,
  ensureSSHSecurityGroup,
  getManagedInstance,
  type InstanceStatus,
} from '../../../services/ec2.js';
import { loadGlobalConfig } from '../../../services/config.js';
import { ensureIamResources, deleteIamResources } from '../../../services/iam.js';
import {
  pushKeyProfileToSSM,
  pushGitHubCredentialsToSSM,
  pushConnectivityProfileToSSM,
} from '../../../services/ssm.js';
import { getProfileWithKeys } from '../../../services/key-profiles.js';
import { listSnapshots, getSnapshot } from '../../../services/workstation-snapshots.js';
import { requireAwsCredentials } from '../../utils/require-aws.js';
import { CLIError } from '../../utils/errors.js';

export const restoreCommand = new Command('restore')
  .description('Restore a workstation from a snapshot')
  .argument('[snapshot-name]', 'Name of the snapshot to restore')
  .option('-n, --name <name>', 'Name for the restored workstation')
  .option('-t, --type <type>', 'Instance type (default: same as snapshot)')
  .option('-r, --region <region>', 'Target region (default: same as snapshot)')
  .action(async (snapshotName: string | undefined, options) => {
    await requireAwsCredentials();

    // Select snapshot
    if (!snapshotName) {
      const snapshots = await listSnapshots();
      if (snapshots.length === 0) {
        throw new CLIError('No snapshots found. Save one first with: clawdult snapshots save');
      }

      snapshotName = await select({
        message: 'Select snapshot to restore:',
        choices: snapshots.map((s) => ({
          value: s.name,
          name: `${s.name} (${s.sourceWorkstationName}, ${s.instanceType}, ${s.region})`,
        })),
      });
    }

    const snapshot = await getSnapshot(snapshotName);
    if (!snapshot) {
      throw new CLIError(`Snapshot '${snapshotName}' not found.`);
    }

    // Verify AMI still exists
    const amiCheck = await describeAmi(snapshot.amiId, snapshot.amiRegion);
    if (!amiCheck) {
      throw new CLIError(
        `AMI ${snapshot.amiId} no longer exists in ${snapshot.amiRegion}. The snapshot cannot be restored.`
      );
    }

    const targetRegion = options.region || snapshot.region;
    const instanceType = options.type || snapshot.instanceType;

    if (options.type) {
      const parsed = InstanceTypeSchema.safeParse(options.type);
      if (!parsed.success) {
        throw new CLIError(
          `Invalid instance type '${options.type}'. Allowed: ${InstanceTypeSchema.options.join(', ')}`
        );
      }
    }

    // Prompt for workstation name
    let workstationName = options.name;
    if (!workstationName) {
      workstationName = await input({
        message: 'Name for the restored workstation:',
        default: snapshot.sourceWorkstationName,
        validate: (v) => {
          const result = WorkstationConfigSchema.shape.name.safeParse(v.trim());
          if (!result.success) {
            return 'Must be lowercase alphanumeric with hyphens, 2-63 characters.';
          }
          return true;
        },
      });
    }

    // Validate name
    const nameResult = WorkstationConfigSchema.shape.name.safeParse(workstationName);
    if (!nameResult.success) {
      throw new CLIError(
        'Invalid name. Must be lowercase alphanumeric with hyphens, 2-63 characters.'
      );
    }

    // Check name doesn't conflict
    const existing = await getManagedInstance(workstationName, targetRegion);
    if (existing) {
      throw new CLIError(
        `Workstation '${workstationName}' already exists in ${targetRegion} (${existing.state}).`
      );
    }

    console.log(chalk.bold('\nRestore Snapshot\n'));
    console.log(chalk.dim(`  Snapshot:       ${snapshot.name}`));
    console.log(chalk.dim(`  Source:         ${snapshot.sourceWorkstationName}`));
    console.log(chalk.dim(`  New name:       ${workstationName}`));
    console.log(chalk.dim(`  Instance type:  ${instanceType}`));
    console.log(chalk.dim(`  Region:         ${targetRegion}`));
    console.log(chalk.dim(`  AMI:            ${snapshot.amiId}`));
    console.log();

    const globalConfig = await loadGlobalConfig();

    // Track resources for cleanup
    let iamCreated = false;
    let instanceId: string | undefined;

    try {
      // Handle cross-region AMI copy
      let amiId = snapshot.amiId;
      if (targetRegion !== snapshot.amiRegion) {
        const copySpinner = ora(
          `Copying AMI to ${targetRegion} (this may take several minutes)...`
        ).start();
        amiId = await copyAmiToRegion(
          snapshot.amiId,
          snapshot.amiRegion,
          targetRegion,
          `clawdult-restore-${workstationName}-${Date.now()}`
        );
        copySpinner.text = `AMI ${amiId} copied, waiting for it to become available...`;
        await waitForAmiAvailable(amiId, targetRegion, { maxWaitTimeSeconds: 900 });
        copySpinner.succeed(`AMI available in ${targetRegion}: ${amiId}`);
      }

      // Ensure security group
      const sgSpinner = ora('Ensuring security group...').start();
      const securityGroupId = await ensureSSHSecurityGroup(
        targetRegion,
        globalConfig.allowedSshCidr
      );
      sgSpinner.succeed('Security group ready');

      // Create IAM resources
      const iamSpinner = ora('Creating IAM resources...').start();
      const iamResources = await ensureIamResources(workstationName, targetRegion);
      iamCreated = true;
      iamSpinner.succeed('IAM resources ready');

      // Re-push SSM parameters from local profiles
      if (snapshot.keyProfileName) {
        const keySpinner = ora(`Pushing key profile '${snapshot.keyProfileName}'...`).start();
        try {
          const profile = await getProfileWithKeys(snapshot.keyProfileName);
          if (profile) {
            await pushKeyProfileToSSM(workstationName, targetRegion, snapshot.keyProfileName);
            keySpinner.succeed(`Key profile '${snapshot.keyProfileName}' pushed`);
          } else {
            keySpinner.warn(`Key profile '${snapshot.keyProfileName}' not found locally, skipping`);
          }
        } catch (error) {
          keySpinner.warn(
            `Failed to push key profile: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (snapshot.githubAgentUsername) {
        const ghSpinner = ora('Pushing GitHub credentials...').start();
        try {
          await pushGitHubCredentialsToSSM(workstationName, targetRegion, {
            username: snapshot.githubAgentUsername,
            email: `${snapshot.githubAgentUsername}@users.noreply.github.com`,
            createdAt: new Date().toISOString(),
          });
          ghSpinner.succeed(`GitHub credentials pushed for ${snapshot.githubAgentUsername}`);
        } catch (error) {
          ghSpinner.warn(
            `Failed to push GitHub credentials: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (snapshot.connectivityProfileName) {
        const connSpinner = ora(
          `Pushing connectivity profile '${snapshot.connectivityProfileName}'...`
        ).start();
        try {
          await pushConnectivityProfileToSSM(
            workstationName,
            targetRegion,
            snapshot.connectivityProfileName
          );
          connSpinner.succeed(`Connectivity profile '${snapshot.connectivityProfileName}' pushed`);
        } catch (error) {
          connSpinner.warn(
            `Failed to push connectivity profile: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Launch instance
      const launchSpinner = ora('Launching instance from snapshot...').start();
      const launchResult = await launchInstance({
        name: workstationName,
        instanceType,
        region: targetRegion,
        volumeSize: snapshot.volumeSize,
        amiId,
        securityGroupIds: [securityGroupId],
        keyName: globalConfig.sshKeyName,
        iamInstanceProfile: iamResources.instanceProfileName,
        keyProfileName: snapshot.keyProfileName,
        githubAgentUsername: snapshot.githubAgentUsername,
      });
      instanceId = launchResult.instanceId;
      launchSpinner.succeed(`Instance launched: ${instanceId}`);

      // Wait for running
      const waitSpinner = ora('Waiting for instance to start...').start();
      const finalStatus = await waitForInstanceRunning(instanceId, targetRegion, {
        onProgress: (status: InstanceStatus) => {
          waitSpinner.text = `Instance state: ${status.state}`;
        },
      });
      waitSpinner.succeed(
        `Instance running: ${finalStatus.publicIpAddress || finalStatus.privateIpAddress || instanceId}`
      );

      console.log(chalk.green('\n✓ Workstation restored from snapshot!\n'));
      console.log(chalk.dim(`  Name:          ${workstationName}`));
      console.log(chalk.dim(`  Instance ID:   ${instanceId}`));
      console.log(chalk.dim(`  Instance type: ${instanceType}`));
      if (finalStatus.publicIpAddress) {
        console.log(chalk.dim(`  Public IP:     ${finalStatus.publicIpAddress}`));
      }
      console.log();
      console.log(chalk.dim(`  Connect: clawdult ssh ${workstationName}`));
      console.log();
    } catch (error) {
      console.error(chalk.red(`\n${error instanceof Error ? error.message : String(error)}`));
      console.error(chalk.yellow('\nCleaning up partially created resources...'));

      if (instanceId) {
        try {
          const { terminateInstance } = await import('../../../services/ec2.js');
          await terminateInstance(instanceId, targetRegion);
          console.error(chalk.dim('  Instance terminated.'));
        } catch (e) {
          console.error(
            chalk.red(
              `  Failed to terminate instance: ${e instanceof Error ? e.message : String(e)}`
            )
          );
        }
      }

      if (iamCreated) {
        try {
          await deleteIamResources(workstationName, targetRegion);
          console.error(chalk.dim('  IAM resources deleted.'));
        } catch (e) {
          console.error(
            chalk.red(
              `  Failed to delete IAM resources: ${e instanceof Error ? e.message : String(e)}`
            )
          );
        }
      }

      process.exit(1);
    }
  });
