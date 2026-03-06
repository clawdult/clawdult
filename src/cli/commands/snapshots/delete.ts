import { Command } from 'commander';
import { select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { deregisterAmi } from '../../../services/ec2.js';
import {
  listSnapshots,
  getSnapshot,
  deleteSnapshot,
} from '../../../services/workstation-snapshots.js';
import { requireAwsCredentials } from '../../utils/require-aws.js';
import { CLIError } from '../../utils/errors.js';

export const deleteCommand = new Command('delete')
  .description('Delete a saved snapshot')
  .argument('[name]', 'Name of the snapshot to delete')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (name: string | undefined, options) => {
    await requireAwsCredentials();

    // Select snapshot
    if (!name) {
      const snapshots = await listSnapshots();
      if (snapshots.length === 0) {
        throw new CLIError('No snapshots found.');
      }

      name = await select({
        message: 'Select snapshot to delete:',
        choices: snapshots.map((s) => ({
          value: s.name,
          name: `${s.name} (${s.sourceWorkstationName}, ${s.amiId})`,
        })),
      });
    }

    const snapshot = await getSnapshot(name);
    if (!snapshot) {
      throw new CLIError(`Snapshot '${name}' not found.`);
    }

    console.log(chalk.bold('\nDelete Snapshot\n'));
    console.log(chalk.dim(`  Name:    ${snapshot.name}`));
    console.log(chalk.dim(`  Source:  ${snapshot.sourceWorkstationName}`));
    console.log(chalk.dim(`  AMI:     ${snapshot.amiId}`));
    console.log(chalk.dim(`  Region:  ${snapshot.amiRegion}\n`));

    if (!options.force) {
      const confirmed = await confirm({
        message: `Delete snapshot '${snapshot.name}'?`,
        default: false,
      });

      if (!confirmed) {
        console.log(chalk.yellow('\nAborted.'));
        return;
      }
    }

    // Ask about AMI deregistration
    let deregister = true;
    if (!options.force) {
      deregister = await confirm({
        message: 'Also deregister the AMI from AWS?',
        default: true,
      });
    }

    if (deregister) {
      const amiSpinner = ora(`Deregistering AMI ${snapshot.amiId}...`).start();
      try {
        await deregisterAmi(snapshot.amiId, snapshot.amiRegion);
        amiSpinner.succeed('AMI deregistered');
      } catch (error) {
        amiSpinner.warn(
          `Failed to deregister AMI: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    await deleteSnapshot(snapshot.name);
    console.log(chalk.green(`\n✓ Snapshot '${snapshot.name}' deleted.\n`));
  });
