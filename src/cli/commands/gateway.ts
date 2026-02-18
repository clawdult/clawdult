import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getGatewayURL, getOpenClawToken, getTailscaleIP } from '../../services/ssm.js';
import { requireAwsCredentials } from '../utils/require-aws.js';
import { resolveInstance } from '../utils/instance-resolver.js';

export const gatewayCommand = new Command('gateway')
  .description('Get gateway connection info for a workstation')
  .argument('[name]', 'Workstation name')
  .option('-r, --region <region>', 'AWS region')
  .option('-j, --json', 'Output as JSON')
  .action(async (name: string | undefined, options) => {
    await requireAwsCredentials();

    const instance = await resolveInstance({
      name,
      region: options.region,
      filterStates: ['running'],
      selectMessage: 'Select workstation:',
    });

    // Fetch gateway info in parallel
    const spinner = ora('Fetching gateway info...').start();
    const [gatewayUrl, token, tailscaleIp] = await Promise.all([
      getGatewayURL(instance.name, instance.region),
      getOpenClawToken(instance.name, instance.region),
      getTailscaleIP(instance.name, instance.region),
    ]);
    spinner.stop();

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            name: instance.name,
            gatewayUrl,
            token,
            tailscaleIp,
            publicIp: instance.publicIp,
            state: instance.state,
          },
          null,
          2
        )
      );
      return;
    }

    console.log(chalk.bold(`\nGateway Info: ${instance.name}\n`));

    if (!token) {
      console.log(chalk.yellow('  No gateway configured for this workstation.'));
      console.log(chalk.dim('  The workstation may not have OpenClaw enabled.\n'));
      return;
    }

    if (gatewayUrl) {
      // Tailscale Serve/Funnel mode
      console.log(`  ${chalk.cyan('Gateway URL:')}    ${gatewayUrl}`);
      console.log(`  ${chalk.cyan('Auth Token:')}    ${token}`);
      console.log();
      console.log(chalk.dim('  Connect using:'));
      console.log(chalk.dim(`    URL:   ${gatewayUrl}`));
      console.log(chalk.dim(`    Token: ${token}`));
    } else {
      // Local mode - show SSH tunnel instructions
      const connectIp = tailscaleIp || instance.publicIp;

      if (!connectIp) {
        console.log(chalk.yellow('  Gateway is in local mode but no IP available.'));
        console.log(chalk.dim('  The workstation may still be initializing.\n'));
        return;
      }

      console.log(chalk.dim('  Gateway is in local mode (SSH tunnel required).'));
      console.log();
      console.log(`  ${chalk.cyan('Auth Token:')}    ${token}`);
      console.log();
      console.log(chalk.dim('  To access the gateway, set up an SSH tunnel:'));
      console.log();
      const sshTarget = `ubuntu@${connectIp}`;
      console.log(chalk.white(`    ssh -L 18789:127.0.0.1:18789 ${sshTarget}`));
      console.log();
      console.log(chalk.dim('  Then connect to:'));
      console.log(chalk.dim('    URL:   http://127.0.0.1:18789'));
      console.log(chalk.dim(`    Token: ${token}`));
    }

    console.log();
  });
