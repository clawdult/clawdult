import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { terminateInstance } from '../../services/ec2.js';
import { requireAwsCredentials } from '../utils/require-aws.js';
import { deleteIamResources } from '../../services/iam.js';
import { resolveInstance } from '../utils/instance-resolver.js';
import { CLIError } from '../utils/errors.js';

export const destroyCommand = new Command('destroy')
  .description('Terminate an EC2 workstation')
  .argument('[name]', 'Name of the workstation to destroy')
  .option('-r, --region <region>', 'AWS region')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (name: string | undefined, options) => {
    // Check AWS credentials before proceeding
    await requireAwsCredentials();

    const instance = await resolveInstance({
      name,
      region: options.region,
      selectMessage: 'Select workstation to destroy:',
    });

    console.log(chalk.bold('\nDestroy Workstation\n'));
    console.log(chalk.dim(`  Name:        ${instance.name}`));
    console.log(chalk.dim(`  Instance ID: ${instance.instanceId}`));
    console.log(chalk.dim(`  Region:      ${instance.region}`));
    console.log(chalk.dim(`  State:       ${instance.state}\n`));

    if (!options.force) {
      console.log(chalk.red.bold('This action cannot be undone!'));
      const confirmed = await confirm({
        message: `Are you sure you want to destroy ${instance.name}?`,
        default: false,
      });

      if (!confirmed) {
        console.log(chalk.yellow('\nAborted.'));
        return;
      }

      // Double confirmation for running instances
      if (instance.state === 'running') {
        const doubleConfirmed = await confirm({
          message: 'This instance is currently RUNNING. Really destroy it?',
          default: false,
        });

        if (!doubleConfirmed) {
          console.log(chalk.yellow('\nAborted.'));
          return;
        }
      }
    }

    const terminateSpinner = ora('Terminating instance...').start();

    try {
      await terminateInstance(instance.instanceId, instance.region);

      terminateSpinner.succeed('Instance terminated');

      // Clean up IAM resources
      const iamSpinner = ora('Cleaning up IAM resources...').start();
      try {
        await deleteIamResources(instance.name, instance.region);
        iamSpinner.succeed('IAM resources cleaned up');
      } catch (error) {
        // Don't fail destroy if IAM cleanup fails - resources are harmless without instance
        iamSpinner.warn(
          `Failed to clean up some IAM resources: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      console.log(chalk.dim(`\n  Instance ${instance.instanceId} has been terminated.\n`));
    } catch (error) {
      terminateSpinner.fail('Failed to terminate instance');
      throw new CLIError(error instanceof Error ? error.message : String(error));
    }
  });
