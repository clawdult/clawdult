import { Command } from 'commander';
import { select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { InstanceTypeSchema, type InstanceType } from '../../schemas/config.js';
import {
  stopInstance,
  waitForInstanceStopped,
  modifyInstanceType,
  startInstance,
  waitForInstanceRunning,
  type InstanceStatus,
} from '../../services/ec2.js';
import { requireAwsCredentials } from '../utils/require-aws.js';
import { resolveInstance } from '../utils/instance-resolver.js';
import { CLIError } from '../utils/errors.js';

export const resizeCommand = new Command('resize')
  .description('Change instance type of a workstation')
  .argument('[name]', 'Name of the workstation to resize')
  .option('-t, --type <type>', 'New instance type (e.g., t3.large)')
  .option('-r, --region <region>', 'AWS region')
  .action(async (name: string | undefined, options) => {
    await requireAwsCredentials();

    const instance = await resolveInstance({
      name,
      region: options.region,
      filterStates: ['running', 'stopped'],
      selectMessage: 'Select workstation to resize:',
    });

    // Determine new instance type
    let newType: InstanceType;
    if (options.type) {
      const parsed = InstanceTypeSchema.safeParse(options.type);
      if (!parsed.success) {
        throw new CLIError(
          `Invalid instance type '${options.type}'. Allowed: ${InstanceTypeSchema.options.join(', ')}`
        );
      }
      newType = parsed.data;
    } else {
      newType = await select({
        message: 'Select new instance type:',
        choices: InstanceTypeSchema.options
          .filter((t) => t !== instance.instanceType)
          .map((t) => ({ value: t, name: t })),
      });
    }

    if (newType === instance.instanceType) {
      console.log(chalk.yellow(`Instance is already ${newType}. Nothing to do.`));
      return;
    }

    console.log(chalk.bold('\nResize Workstation\n'));
    console.log(chalk.dim(`  Name:           ${instance.name}`));
    console.log(chalk.dim(`  Instance ID:    ${instance.instanceId}`));
    console.log(chalk.dim(`  Current type:   ${instance.instanceType}`));
    console.log(chalk.dim(`  New type:       ${newType}`));
    console.log(chalk.dim(`  State:          ${instance.state}\n`));

    if (instance.state === 'running') {
      console.log(chalk.yellow('The instance must be stopped to change its type.'));
      const confirmed = await confirm({
        message: 'Stop the instance, resize, and restart?',
        default: true,
      });

      if (!confirmed) {
        console.log(chalk.yellow('\nAborted.'));
        return;
      }

      const stopSpinner = ora('Stopping instance...').start();
      try {
        await stopInstance(instance.instanceId, instance.region);
        await waitForInstanceStopped(instance.instanceId, instance.region, {
          onProgress: (status: InstanceStatus) => {
            stopSpinner.text = `Stopping instance... (${status.state})`;
          },
        });
        stopSpinner.succeed('Instance stopped');
      } catch (error) {
        stopSpinner.fail('Failed to stop instance');
        throw new CLIError(error instanceof Error ? error.message : String(error));
      }
    }

    const modifySpinner = ora(`Changing instance type to ${newType}...`).start();
    try {
      await modifyInstanceType(instance.instanceId, instance.region, newType);
      modifySpinner.succeed(`Instance type changed to ${newType}`);
    } catch (error) {
      modifySpinner.fail('Failed to modify instance type');
      throw new CLIError(error instanceof Error ? error.message : String(error));
    }

    const startSpinner = ora('Starting instance...').start();
    try {
      await startInstance(instance.instanceId, instance.region);
      const finalStatus = await waitForInstanceRunning(instance.instanceId, instance.region, {
        onProgress: (status: InstanceStatus) => {
          startSpinner.text = `Starting instance... (${status.state})`;
        },
      });
      startSpinner.succeed(
        `Instance running: ${finalStatus.publicIpAddress || finalStatus.privateIpAddress || instance.instanceId}`
      );

      console.log(chalk.green('\n✓ Workstation resized successfully!\n'));
      console.log(chalk.dim(`  Instance type: ${newType}`));
      if (finalStatus.publicIpAddress) {
        console.log(chalk.dim(`  Public IP:     ${finalStatus.publicIpAddress}`));
      }
      console.log();
    } catch (error) {
      startSpinner.fail('Failed to start instance');
      throw new CLIError(error instanceof Error ? error.message : String(error));
    }
  });
