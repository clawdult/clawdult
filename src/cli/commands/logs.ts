import { Command } from 'commander';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { loadGlobalConfig } from '../../services/config.js';
import { requireAwsCredentials } from '../utils/require-aws.js';
import { resolveInstance } from '../utils/instance-resolver.js';
import { resolveSSHConnection } from '../utils/ssh-connection.js';
import { CLIError } from '../utils/errors.js';

export const logsCommand = new Command('logs')
  .description('View agent logs from a workstation')
  .argument('[name]', 'Name of the workstation')
  .option('-r, --region <region>', 'AWS region')
  .option('-f, --follow', 'Follow log output (like tail -f)')
  .option('-n, --lines <num>', 'Number of lines to show', '100')
  .option('--type <type>', 'Log type: agent, audit, cli', 'agent')
  .option('-i, --identity <path>', 'Path to SSH private key')
  .option('-t, --tailscale', 'Force Tailscale connection (uses Tailscale IP)')
  .action(async (name: string | undefined, options) => {
    await requireAwsCredentials();

    const globalConfig = await loadGlobalConfig();
    const region = options.region || globalConfig.defaultRegion;

    const instance = await resolveInstance({
      name,
      region,
      selectMessage: 'Select workstation:',
    });

    // Validate log type
    const validTypes = ['agent', 'audit', 'cli'];
    if (!validTypes.includes(options.type)) {
      throw new CLIError(`Invalid log type. Must be one of: ${validTypes.join(', ')}`);
    }

    if (instance.state !== 'running') {
      throw new CLIError(
        `Workstation '${instance.name}' is not running (current state: ${instance.state}).`
      );
    }

    const connection = await resolveSSHConnection({
      instance,
      region,
      forceTailscale: options.tailscale,
    });

    // Resolve SSH key path: CLI option > global sshKeyPath > sshKeyPaths lookup by key name
    let identityPath = options.identity || globalConfig.sshKeyPath;
    if (
      !identityPath &&
      globalConfig.sshKeyName &&
      globalConfig.sshKeyPaths?.[globalConfig.sshKeyName]
    ) {
      identityPath = globalConfig.sshKeyPaths[globalConfig.sshKeyName];
    }

    // Build SSH args
    const sshArgs: string[] = [];
    if (identityPath) {
      sshArgs.push('-i', identityPath);
    }
    sshArgs.push('-o', 'StrictHostKeyChecking=accept-new');
    sshArgs.push(`ubuntu@${connection.ip}`);

    // Build tail command
    const logPath = `/opt/clawdult/logs/${options.type}`;
    let tailCmd = `tail -n ${options.lines}`;
    if (options.follow) {
      tailCmd += ' -f';
    }
    tailCmd += ` ${logPath}/*.log 2>/dev/null || echo "No logs found in ${logPath}"`;
    sshArgs.push(tailCmd);

    const methodLabel = connection.method === 'tailscale' ? 'Tailscale' : 'public IP';
    console.log(
      chalk.dim(`\nFetching ${options.type} logs from ${instance.name} via ${methodLabel}...\n`)
    );

    const ssh = spawn('ssh', sshArgs, { stdio: 'inherit' });

    ssh.on('error', (error) => {
      console.error(chalk.red(`Failed to start SSH: ${error.message}`));
      process.exit(1);
    });

    ssh.on('exit', (code) => {
      process.exit(code || 0);
    });
  });
