import { Command } from 'commander';
import chalk from 'chalk';
import { listSnapshots } from '../../../services/workstation-snapshots.js';

export const listCommand = new Command('list')
  .description('List all saved snapshots')
  .action(async () => {
    const snapshots = await listSnapshots();

    if (snapshots.length === 0) {
      console.log(chalk.dim('\nNo snapshots saved.\n'));
      console.log(chalk.dim('  Save one with: clawdult snapshots save [workstation-name]\n'));
      return;
    }

    console.log(chalk.bold('\nSaved Snapshots\n'));

    // Table header
    const nameW = 20;
    const sourceW = 18;
    const typeW = 12;
    const regionW = 14;
    const amiW = 24;
    const dateW = 12;

    console.log(
      chalk.dim(
        '  ' +
          'Name'.padEnd(nameW) +
          'Source'.padEnd(sourceW) +
          'Type'.padEnd(typeW) +
          'Region'.padEnd(regionW) +
          'AMI'.padEnd(amiW) +
          'Created'.padEnd(dateW)
      )
    );
    console.log(chalk.dim('  ' + '-'.repeat(nameW + sourceW + typeW + regionW + amiW + dateW)));

    for (const snap of snapshots) {
      const date = snap.createdAt.slice(0, 10);
      console.log(
        '  ' +
          chalk.cyan(snap.name.padEnd(nameW)) +
          snap.sourceWorkstationName.padEnd(sourceW) +
          snap.instanceType.padEnd(typeW) +
          snap.region.padEnd(regionW) +
          chalk.dim(snap.amiId.padEnd(amiW)) +
          chalk.dim(date.padEnd(dateW))
      );
    }

    console.log();
  });
