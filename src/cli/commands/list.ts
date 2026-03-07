import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { listManagedInstances, type ManagedInstance } from '../../services/ec2.js';
import { RegionSchema } from '../../schemas/config.js';
import { requireAwsCredentials } from '../utils/require-aws.js';
import { formatState, formatDuration } from '../utils/format.js';

export const listCommand = new Command('list')
  .description('List all Clawdult workstations from AWS')
  .option('-r, --region <region>', 'Query only a specific region (default: all regions)')
  .option('-j, --json', 'Output as JSON')
  .option('--include-terminated', 'Include terminated instances')
  .action(async (options) => {
    await requireAwsCredentials();

    const allInstances: ManagedInstance[] = [];

    if (options.region) {
      // Query single region
      const spinner = ora(`Querying ${options.region}...`).start();

      const instances = await listManagedInstances(options.region, {
        includeTerminated: options.includeTerminated,
      });
      allInstances.push(...instances);
      spinner.succeed(`Found ${allInstances.length} instance(s) in ${options.region}`);
    } else {
      // Query all regions in parallel (default)
      const spinner = ora('Querying all regions...').start();
      const regions = RegionSchema.options;

      const results = await Promise.allSettled(
        regions.map((region) =>
          listManagedInstances(region, { includeTerminated: options.includeTerminated })
        )
      );

      const failedRegions: { region: string; error: string }[] = [];

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const region = regions[i];
        if (result.status === 'fulfilled') {
          allInstances.push(...result.value);
        } else {
          failedRegions.push({
            region,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }

      const successfulRegions = regions.length - failedRegions.length;

      if (failedRegions.length === 0) {
        spinner.succeed(
          `Found ${allInstances.length} instance(s) across ${regions.length} regions`
        );
      } else if (successfulRegions > 0) {
        spinner.warn(
          `Found ${allInstances.length} instance(s) across ${successfulRegions} of ${regions.length} regions (${failedRegions.length} failed)`
        );
      } else {
        spinner.fail(`Failed to query all ${regions.length} regions`);
      }

      if (failedRegions.length > 0) {
        console.log(chalk.yellow(`\n  Failed to query ${failedRegions.length} region(s):`));
        for (const { region, error } of failedRegions) {
          console.log(chalk.dim(`    ${region}: ${error}`));
        }
      }
    }

    if (allInstances.length === 0) {
      console.log(chalk.yellow('\nNo workstations found.\n'));
      console.log(chalk.dim(`Create one with: ${chalk.white('clawdult create <name>')}\n`));
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(allInstances, null, 2));
      return;
    }

    console.log(chalk.bold('\nClawdult Workstations\n'));

    // Header
    console.log(
      chalk.dim('  ') +
        chalk.dim('NAME'.padEnd(20)) +
        chalk.dim('STATUS'.padEnd(16)) +
        chalk.dim('WS TYPE'.padEnd(18)) +
        chalk.dim('INSTANCE'.padEnd(12)) +
        chalk.dim('REGION'.padEnd(14)) +
        chalk.dim('UPTIME')
    );
    console.log(chalk.dim('  ' + '─'.repeat(90)));

    for (const instance of allInstances) {
      console.log(
        '  ' +
          instance.name.padEnd(20) +
          formatState(instance.state).padEnd(16 + 10) + // +10 for ANSI codes
          (instance.workstationTypeName || '-').padEnd(18) +
          instance.instanceType.padEnd(12) +
          instance.region.padEnd(14) +
          formatDuration(instance.launchTime)
      );
    }

    console.log('');
  });
