import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { startInstance, waitForInstanceRunning, type InstanceStatus } from '../../services/ec2.js';
import { requireAwsCredentials } from '../utils/require-aws.js';
import { resolveInstance } from '../utils/instance-resolver.js';
import { CLIError } from '../utils/errors.js';

export const startCommand = new Command('start')
  .description('Start a stopped workstation')
  .argument('[name]', 'Name of the workstation to start')
  .option('-r, --region <region>', 'AWS region')
  .action(async (name: string | undefined, options) => {
    await requireAwsCredentials();

    const instance = await resolveInstance({
      name,
      region: options.region,
      filterStates: ['stopped'],
      selectMessage: 'Select workstation to start:',
    });

    const spinner = ora('Starting instance...').start();
    try {
      await startInstance(instance.instanceId, instance.region);
      const finalStatus = await waitForInstanceRunning(instance.instanceId, instance.region, {
        onProgress: (status: InstanceStatus) => {
          spinner.text = `Starting instance... (${status.state})`;
        },
      });
      spinner.succeed(
        `Instance running: ${finalStatus.publicIpAddress || finalStatus.privateIpAddress || instance.instanceId}`
      );

      console.log(chalk.green('\n✓ Workstation started!\n'));
      console.log(chalk.dim(`  Name:        ${instance.name}`));
      if (finalStatus.publicIpAddress) {
        console.log(chalk.dim(`  Public IP:   ${finalStatus.publicIpAddress}`));
      }
      console.log();
    } catch (error) {
      spinner.fail('Failed to start instance');
      throw new CLIError(error instanceof Error ? error.message : String(error));
    }
  });
