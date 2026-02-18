import { Command } from 'commander';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import { loadGlobalConfig } from '../../services/config.js';
import { requireAwsCredentials } from '../utils/require-aws.js';
import { resolveInstance } from '../utils/instance-resolver.js';
import { resolveSSHConnection } from '../utils/ssh-connection.js';
import { CLIError } from '../utils/errors.js';

export const sshCommand = new Command('ssh')
  .description('SSH into a workstation')
  .argument('[name]', 'Name of the workstation')
  .option('-r, --region <region>', 'AWS region')
  .option('-i, --identity <path>', 'Path to SSH private key')
  .option('-u, --user <user>', 'SSH username', 'ubuntu')
  .option('-p, --port <port>', 'SSH port', '22')
  .option('-t, --tailscale', 'Force Tailscale connection (uses Tailscale IP)')
  .option('--command <cmd>', 'Run a command instead of interactive shell')
  .action(async (name: string | undefined, options) => {
    await requireAwsCredentials();

    const globalConfig = await loadGlobalConfig();
    const region = options.region || globalConfig.defaultRegion;

    const instance = await resolveInstance({
      name,
      region,
      filterStates: ['running'],
      selectMessage: 'Select workstation to SSH into:',
    });

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

    // Build SSH command
    const sshArgs: string[] = [];

    if (identityPath) {
      sshArgs.push('-i', identityPath);
    }

    sshArgs.push('-p', options.port);
    sshArgs.push('-o', 'StrictHostKeyChecking=accept-new');
    sshArgs.push(`${options.user}@${connection.ip}`);

    if (options.command) {
      sshArgs.push(options.command);
    }

    const methodLabel = connection.method === 'tailscale' ? 'Tailscale' : 'public IP';
    console.log(
      chalk.dim(`\nConnecting to ${instance.name} via ${methodLabel} (${connection.ip})...\n`)
    );

    const ssh = spawn('ssh', sshArgs, {
      stdio: 'inherit',
    });

    ssh.on('error', (error) => {
      console.error(chalk.red(`Failed to start SSH: ${error.message}`));
      process.exit(1);
    });

    ssh.on('exit', (code) => {
      process.exit(code || 0);
    });
  });
