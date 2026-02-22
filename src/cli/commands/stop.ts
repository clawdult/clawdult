import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { stopInstance, waitForInstanceStopped, type InstanceStatus } from '../../services/ec2.js';
import { requireAwsCredentials } from '../utils/require-aws.js';
import { resolveInstance } from '../utils/instance-resolver.js';
import { CLIError } from '../utils/errors.js';

export const stopCommand = new Command('stop')
  .description('Stop a running workstation')
  .argument('[name]', 'Name of the workstation to stop')
  .option('-r, --region <region>', 'AWS region')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (name: string | undefined, options) => {
    await requireAwsCredentials();

    const instance = await resolveInstance({
      name,
      region: options.region,
      filterStates: ['running'],
      selectMessage: 'Select workstation to stop:',
    });

    console.log(chalk.bold('\nStop Workstation\n'));
    console.log(chalk.dim(`  Name:        ${instance.name}`));
    console.log(chalk.dim(`  Instance ID: ${instance.instanceId}`));
    console.log(chalk.dim(`  Region:      ${instance.region}`));
    console.log(chalk.dim(`  State:       ${instance.state}\n`));

    if (!options.force) {
      const confirmed = await confirm({
        message: `Stop ${instance.name}?`,
        default: true,
      });

      if (!confirmed) {
        console.log(chalk.yellow('\nAborted.'));
        return;
      }
    }

    const spinner = ora('Stopping instance...').start();
    try {
      await stopInstance(instance.instanceId, instance.region);
      await waitForInstanceStopped(instance.instanceId, instance.region, {
        onProgress: (status: InstanceStatus) => {
          spinner.text = `Stopping instance... (${status.state})`;
        },
      });
      spinner.succeed('Instance stopped');

      console.log(chalk.dim(`\n  ${instance.name} has been stopped.`));
      console.log(
        chalk.dim(`  Run ${chalk.bold('clawdult start ' + instance.name)} to resume it.\n`)
      );
    } catch (error) {
      spinner.fail('Failed to stop instance');
      throw new CLIError(error instanceof Error ? error.message : String(error));
    }
  });
