import { Command } from 'commander';
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { DescribeInstancesCommand, DescribeVolumesCommand, EC2Client } from '@aws-sdk/client-ec2';
import type { WorkstationSnapshot, InstanceType, Region } from '../../../schemas/config.js';
import { createAmiFromInstance, waitForAmiAvailable } from '../../../services/ec2.js';
import { getAWSClientConfig } from '../../../services/aws-client.js';
import { saveSnapshot, getSnapshot } from '../../../services/workstation-snapshots.js';
import { requireAwsCredentials } from '../../utils/require-aws.js';
import { resolveInstance } from '../../utils/instance-resolver.js';
import { CLIError } from '../../utils/errors.js';

export const saveCommand = new Command('save')
  .description('Save a workstation snapshot')
  .argument('[workstation-name]', 'Name of the workstation to snapshot')
  .option('-n, --name <name>', 'Name for the snapshot')
  .option('-d, --description <description>', 'Description for the snapshot')
  .option('-r, --region <region>', 'AWS region')
  .action(async (workstationName: string | undefined, options) => {
    await requireAwsCredentials();

    const instance = await resolveInstance({
      name: workstationName,
      region: options.region,
      filterStates: ['running', 'stopped'],
      selectMessage: 'Select workstation to snapshot:',
    });

    // Determine snapshot name
    const defaultName = `${instance.name}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    let snapshotName = options.name;
    if (!snapshotName) {
      snapshotName = await input({
        message: 'Snapshot name:',
        default: defaultName,
        validate: (v) => {
          if (!v.trim()) return 'Name is required';
          if (!/^[a-zA-Z0-9-_]+$/.test(v.trim())) {
            return 'Must be alphanumeric with hyphens/underscores';
          }
          if (v.trim().length > 50) return 'Max 50 characters';
          return true;
        },
      });
    }

    // Check if snapshot name already exists
    const existing = await getSnapshot(snapshotName);
    if (existing) {
      throw new CLIError(`Snapshot '${snapshotName}' already exists. Choose a different name.`);
    }

    // Get volume size from source instance's root volume
    const ec2Client = new EC2Client(await getAWSClientConfig(instance.region));
    const describeResponse = await ec2Client.send(
      new DescribeInstancesCommand({ InstanceIds: [instance.instanceId] })
    );
    const sourceInstance = describeResponse.Reservations?.[0]?.Instances?.[0];
    let volumeSize = 50;
    const rootVolumeId = sourceInstance?.BlockDeviceMappings?.[0]?.Ebs?.VolumeId;
    if (rootVolumeId) {
      const volResponse = await ec2Client.send(
        new DescribeVolumesCommand({ VolumeIds: [rootVolumeId] })
      );
      volumeSize = volResponse.Volumes?.[0]?.Size || 50;
    }

    console.log(chalk.bold('\nSave Snapshot\n'));
    console.log(chalk.dim(`  Workstation: ${instance.name} (${instance.instanceId})`));
    console.log(chalk.dim(`  Snapshot:    ${snapshotName}`));
    console.log(chalk.dim(`  Region:      ${instance.region}\n`));
    console.log(chalk.yellow('Creating AMI from instance. This typically takes 5-15 minutes.\n'));

    const amiSpinner = ora('Creating AMI...').start();
    try {
      const amiName = `clawdult-snapshot-${snapshotName}-${Date.now()}`;
      const amiId = await createAmiFromInstance(
        instance.instanceId,
        instance.region,
        amiName,
        options.description || `Snapshot of ${instance.name}: ${snapshotName}`
      );
      amiSpinner.text = `AMI ${amiId} created, waiting for it to become available...`;

      await waitForAmiAvailable(amiId, instance.region, { maxWaitTimeSeconds: 900 });
      amiSpinner.succeed(`AMI ready: ${amiId}`);

      // Save snapshot metadata
      const snapshot: WorkstationSnapshot = {
        name: snapshotName,
        createdAt: new Date().toISOString(),
        description: options.description,
        amiId,
        amiRegion: instance.region as Region,
        sourceWorkstationName: instance.name,
        sourceInstanceId: instance.instanceId,
        instanceType: instance.instanceType as InstanceType,
        region: instance.region as Region,
        volumeSize,
        keyProfileName: instance.keyProfileName,
        githubAgentUsername: instance.githubAgentUsername,
      };

      await saveSnapshot(snapshot);

      console.log(chalk.green('\n✓ Snapshot saved!\n'));
      console.log(chalk.dim(`  Name:    ${snapshotName}`));
      console.log(chalk.dim(`  AMI:     ${amiId}`));
      console.log(chalk.dim(`  Region:  ${instance.region}`));
      console.log();
      console.log(chalk.dim(`  Restore: clawdult snapshots restore ${snapshotName}`));
      console.log();
    } catch (error) {
      amiSpinner.fail('Failed to create snapshot');
      throw new CLIError(error instanceof Error ? error.message : String(error));
    }
  });
