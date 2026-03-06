import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { listManagedInstances } from '../../services/ec2.js';
import { getGatewayURL } from '../../services/ssm.js';
import { requireAwsCredentials } from '../utils/require-aws.js';
import { formatState, formatDuration } from '../utils/format.js';
import { resolveInstance } from '../utils/instance-resolver.js';
import { loadGlobalConfig } from '../../services/config.js';

export const statusCommand = new Command('status')
  .description('Show workstation status')
  .argument('[name]', 'Name of specific workstation (shows all if omitted)')
  .option('-r, --region <region>', 'AWS region to query')
  .option('-j, --json', 'Output as JSON')
  .action(async (name: string | undefined, options) => {
    await requireAwsCredentials();

    if (name) {
      // Show specific workstation
      const instance = await resolveInstance({ name, region: options.region });

      if (options.json) {
        console.log(JSON.stringify(instance, null, 2));
        return;
      }

      console.log(chalk.bold(`\nWorkstation: ${instance.name}\n`));
      console.log(`  Status:        ${formatState(instance.state)}`);
      if (instance.workstationTypeName) {
        console.log(`  WS Type:       ${chalk.dim(instance.workstationTypeName)}`);
      }
      console.log(`  Instance ID:   ${chalk.dim(instance.instanceId)}`);
      console.log(`  Instance Type: ${chalk.dim(instance.instanceType)}`);
      console.log(`  Region:        ${chalk.dim(instance.region)}`);
      console.log(`  Uptime:        ${chalk.dim(formatDuration(instance.launchTime))}`);

      if (instance.publicIp) {
        console.log(`  Public IP:     ${chalk.cyan(instance.publicIp)}`);
      }
      if (instance.privateIp) {
        console.log(`  Private IP:    ${chalk.dim(instance.privateIp)}`);
      }

      if (instance.keyProfileName) {
        console.log(`  Key Profile:   ${chalk.dim(instance.keyProfileName)}`);
      }
      if (instance.githubAgentUsername) {
        console.log(`  GitHub Agent:  ${chalk.dim(instance.githubAgentUsername)}`);
      }
      if (instance.capabilities && instance.capabilities.length > 0) {
        console.log(`  Capabilities:  ${chalk.dim(instance.capabilities.join(', '))}`);
      }

      // Check for gateway URL (Tailscale Serve/Funnel)
      const gatewayUrl = await getGatewayURL(instance.name, instance.region);
      if (gatewayUrl) {
        console.log(`  Gateway URL:   ${chalk.cyan(gatewayUrl)}`);
      }

      console.log('');
      return;
    }

    // Show all workstations
    const globalConfig = await loadGlobalConfig();
    const region = options.region || globalConfig.defaultRegion;

    const spinner = ora(`Querying ${region}...`).start();
    const instances = await listManagedInstances(region);
    spinner.stop();

    if (instances.length === 0) {
      console.log(chalk.yellow('\nNo workstations found.\n'));
      console.log(chalk.dim(`Create one with: ${chalk.white('clawdult create <name>')}\n`));
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(instances, null, 2));
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

    for (const instance of instances) {
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
