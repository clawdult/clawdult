import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getOpenClawToken } from '../../services/ssm.js';
import { loadGlobalConfig } from '../../services/config.js';
import { requireAwsCredentials } from '../utils/require-aws.js';
import { CLIError } from '../utils/errors.js';

export const secretsCommand = new Command('secrets')
  .description('Retrieve secrets for workstations')
  .action(async () => {
    console.log(chalk.bold('\nWorkstation Secrets\n'));
    console.log(chalk.dim('Commands:'));
    console.log(
      chalk.dim('  clawdult secrets openclaw-token <name>  Retrieve OpenClaw gateway token')
    );
    console.log();
  });

secretsCommand
  .command('openclaw-token <name>')
  .description('Retrieve the OpenClaw gateway token for a workstation')
  .option('-r, --region <region>', 'AWS region (uses default if not specified)')
  .action(async (name: string, options: { region?: string }) => {
    await requireAwsCredentials();

    const globalConfig = await loadGlobalConfig();
    const region = options.region || globalConfig.defaultRegion || 'us-west-2';

    const spinner = ora('Retrieving OpenClaw token...').start();

    try {
      const token = await getOpenClawToken(name, region);

      if (!token) {
        spinner.fail(`No OpenClaw token found for workstation '${name}'`);
        throw new CLIError(
          `No OpenClaw token found for workstation '${name}'. The workstation may not have OpenClaw configured. Ensure you created it with a connectivity profile that has OpenClaw enabled.`
        );
      }

      spinner.succeed('Token retrieved');
      console.log(chalk.cyan('\n  OpenClaw Gateway Token:'));
      console.log(chalk.white(`  ${token}`));
      console.log();
    } catch (error) {
      if (error instanceof CLIError) throw error;
      spinner.fail('Failed to retrieve token');
      throw new CLIError(error instanceof Error ? error.message : String(error));
    }
  });
