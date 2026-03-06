import { Command } from 'commander';
import { input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { DescribeInstancesCommand, DescribeVolumesCommand, EC2Client } from '@aws-sdk/client-ec2';
import { WorkstationConfigSchema, InstanceTypeSchema } from '../../schemas/config.js';
import {
  createAmiFromInstance,
  waitForAmiAvailable,
  launchInstance,
  waitForInstanceRunning,
  getManagedInstance,
  type InstanceStatus,
} from '../../services/ec2.js';
import { getAWSClientConfig } from '../../services/aws-client.js';
import {
  ensureIamResources,
  deleteIamResources,
  attachCustomPermissions,
} from '../../services/iam.js';
import { getPermissionsProfile } from '../../services/permissions-profiles.js';
import { copySSMParameters } from '../../services/ssm.js';
import { requireAwsCredentials } from '../utils/require-aws.js';
import { resolveInstance } from '../utils/instance-resolver.js';
import { CLIError } from '../utils/errors.js';

export const cloneCommand = new Command('clone')
  .description('Create a copy of a workstation with all disk state')
  .argument('[name]', 'Name of the source workstation')
  .argument('[new-name]', 'Name for the cloned workstation')
  .option('-t, --type <type>', 'Instance type for the clone (default: same as source)')
  .option('-r, --region <region>', 'AWS region')
  .action(async (name: string | undefined, newName: string | undefined, options) => {
    await requireAwsCredentials();

    const source = await resolveInstance({
      name,
      region: options.region,
      filterStates: ['running', 'stopped'],
      selectMessage: 'Select workstation to clone:',
    });

    // Prompt for new name if not provided
    if (!newName) {
      newName = await input({
        message: 'Name for the cloned workstation:',
        default: `${source.name}-clone`,
        validate: (v) => {
          const result = WorkstationConfigSchema.shape.name.safeParse(v.trim());
          if (!result.success) {
            return 'Must be lowercase alphanumeric with hyphens, 2-63 characters.';
          }
          return true;
        },
      });
    }

    // Validate new name
    const nameResult = WorkstationConfigSchema.shape.name.safeParse(newName);
    if (!nameResult.success) {
      throw new CLIError(
        'Invalid name. Must be lowercase alphanumeric with hyphens, 2-63 characters.'
      );
    }

    // Check name doesn't conflict
    const existing = await getManagedInstance(newName, source.region);
    if (existing) {
      throw new CLIError(
        `Workstation '${newName}' already exists in ${source.region} (${existing.state}).`
      );
    }

    const instanceType = options.type || source.instanceType;
    if (options.type) {
      const parsed = InstanceTypeSchema.safeParse(options.type);
      if (!parsed.success) {
        throw new CLIError(
          `Invalid instance type '${options.type}'. Allowed: ${InstanceTypeSchema.options.join(', ')}`
        );
      }
    }

    console.log(chalk.bold('\nClone Workstation\n'));
    console.log(chalk.dim(`  Source:         ${source.name} (${source.instanceId})`));
    console.log(chalk.dim(`  New name:       ${newName}`));
    console.log(chalk.dim(`  Instance type:  ${instanceType}`));
    console.log(chalk.dim(`  Region:         ${source.region}\n`));

    console.log(
      chalk.yellow('Creating an AMI from the source instance. This typically takes 5-15 minutes.\n')
    );

    const confirmed = await confirm({
      message: 'Proceed with clone?',
      default: true,
    });

    if (!confirmed) {
      console.log(chalk.yellow('\nAborted.'));
      return;
    }

    // Track resources for cleanup
    let amiId: string | undefined;
    let iamCreated = false;
    let instanceId: string | undefined;

    try {
      // 1. Create AMI from source
      const amiSpinner = ora('Creating AMI from source instance...').start();
      const amiName = `clawdult-clone-${newName}-${Date.now()}`;
      amiId = await createAmiFromInstance(
        source.instanceId,
        source.region,
        amiName,
        `Clone of ${source.name} for ${newName}`
      );
      amiSpinner.text = `AMI ${amiId} created, waiting for it to become available...`;

      await waitForAmiAvailable(amiId, source.region, { maxWaitTimeSeconds: 900 });
      amiSpinner.succeed(`AMI ready: ${amiId}`);

      // 2. Create IAM resources
      const iamSpinner = ora('Creating IAM resources...').start();
      const iamResources = await ensureIamResources(newName, source.region);
      iamCreated = true;
      iamSpinner.succeed('IAM resources ready');

      // 3. Copy SSM parameters
      const ssmSpinner = ora('Copying SSM parameters...').start();
      const ssmResult = await copySSMParameters(source.name, newName, source.region);
      if (ssmResult.failed.length > 0) {
        ssmSpinner.warn(
          `Copied ${ssmResult.copied.length} params, ${ssmResult.failed.length} failed`
        );
      } else {
        ssmSpinner.succeed(`Copied ${ssmResult.copied.length} SSM parameters`);
      }

      // 4. Get source instance details for security group, key pair, and volume size
      const ec2Client = new EC2Client(await getAWSClientConfig(source.region));
      const describeResponse = await ec2Client.send(
        new DescribeInstancesCommand({ InstanceIds: [source.instanceId] })
      );
      const sourceInstance = describeResponse.Reservations?.[0]?.Instances?.[0];
      const securityGroupIds =
        sourceInstance?.SecurityGroups?.map((sg) => sg.GroupId!).filter(Boolean) || [];
      const keyName = sourceInstance?.KeyName;

      // Get volume size from the root volume
      let volumeSize = 50;
      const rootVolumeId = sourceInstance?.BlockDeviceMappings?.[0]?.Ebs?.VolumeId;
      if (rootVolumeId) {
        const volResponse = await ec2Client.send(
          new DescribeVolumesCommand({ VolumeIds: [rootVolumeId] })
        );
        volumeSize = volResponse.Volumes?.[0]?.Size || 50;
      }

      // 5. Propagate custom permissions if source had them
      if (source.permissionsProfileName) {
        const permSpinner = ora(
          `Attaching permissions profile '${source.permissionsProfileName}'...`
        ).start();
        try {
          const permProfile = await getPermissionsProfile(source.permissionsProfileName);
          if (permProfile) {
            await attachCustomPermissions(newName, source.region, permProfile.statements);
            permSpinner.succeed(`Permissions profile '${source.permissionsProfileName}' attached`);
          } else {
            permSpinner.warn(
              `Permissions profile '${source.permissionsProfileName}' not found locally, skipping`
            );
          }
        } catch (error) {
          permSpinner.warn(
            `Failed to attach permissions: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // 6. Launch new instance from AMI
      const launchSpinner = ora('Launching cloned instance...').start();
      const launchResult = await launchInstance({
        name: newName,
        instanceType,
        region: source.region,
        volumeSize,
        amiId,
        securityGroupIds,
        keyName,
        iamInstanceProfile: iamResources.instanceProfileName,
        keyProfileName: source.keyProfileName,
        permissionsProfileName: source.permissionsProfileName,
        githubAgentUsername: source.githubAgentUsername,
      });
      instanceId = launchResult.instanceId;
      launchSpinner.succeed(`Instance launched: ${instanceId}`);

      // 7. Wait for running
      const waitSpinner = ora('Waiting for instance to start...').start();
      const finalStatus = await waitForInstanceRunning(instanceId, source.region, {
        onProgress: (status: InstanceStatus) => {
          waitSpinner.text = `Instance state: ${status.state}`;
        },
      });
      waitSpinner.succeed(
        `Instance running: ${finalStatus.publicIpAddress || finalStatus.privateIpAddress || instanceId}`
      );

      console.log(chalk.green('\n✓ Workstation cloned successfully!\n'));
      console.log(chalk.dim(`  Name:          ${newName}`));
      console.log(chalk.dim(`  Instance ID:   ${instanceId}`));
      console.log(chalk.dim(`  Instance type: ${instanceType}`));
      if (finalStatus.publicIpAddress) {
        console.log(chalk.dim(`  Public IP:     ${finalStatus.publicIpAddress}`));
      }
      console.log(chalk.dim(`  AMI:           ${amiId}`));
      console.log();
      console.log(chalk.dim(`  Connect: clawdult ssh ${newName}`));
      console.log();
    } catch (error) {
      console.error(chalk.red(`\n${error instanceof Error ? error.message : String(error)}`));
      console.error(chalk.yellow('\nCleaning up partially created resources...'));

      if (instanceId) {
        try {
          const { terminateInstance } = await import('../../services/ec2.js');
          await terminateInstance(instanceId, source.region);
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
          await deleteIamResources(newName, source.region);
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
