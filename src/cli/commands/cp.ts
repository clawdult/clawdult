import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { loadGlobalConfig } from '../../services/config.js';
import { getManagedInstance, listManagedInstances } from '../../services/ec2.js';
import { getTailscaleIP } from '../../services/ssm.js';
import { requireAwsCredentials } from '../utils/require-aws.js';

function isRemotePath(p: string): boolean {
  return p.startsWith(':');
}

export const cpCommand = new Command('cp')
  .description('Copy files to/from a workstation')
  .argument('[name]', 'Name of the workstation')
  .argument('[paths...]', 'Source and destination paths (prefix remote paths with :)')
  .option('-r, --region <region>', 'AWS region')
  .option('-i, --identity <path>', 'Path to SSH private key')
  .option('-u, --user <user>', 'SSH username', 'ubuntu')
  .option('-p, --port <port>', 'SSH port', '22')
  .option('-t, --tailscale', 'Force Tailscale connection (uses Tailscale IP)')
  .option('--no-progress', 'Disable transfer progress')
  .action(async (name: string | undefined, paths: string[], options) => {
    await requireAwsCredentials();

    const globalConfig = await loadGlobalConfig();
    const region = options.region || globalConfig.defaultRegion;

    let targetName = name;

    if (!targetName) {
      const spinner = ora(`Querying ${region}...`).start();
      const instances = await listManagedInstances(region);
      spinner.stop();

      const running = instances.filter((w) => w.state === 'running');

      if (running.length === 0) {
        console.log(chalk.yellow('No running workstations found.'));
        if (instances.length > 0) {
          console.log(chalk.dim('\nStopped/pending workstations:'));
          instances.forEach((w) => {
            console.log(chalk.dim(`  - ${w.name} (${w.state})`));
          });
        }
        return;
      }

      targetName = await select({
        message: 'Select workstation to copy files to/from:',
        choices: running.map((w) => ({
          value: w.name,
          name: `${w.name} (${w.publicIp || 'no public IP'})`,
        })),
      });
    }

    if (paths.length === 0) {
      console.error(chalk.red('No paths specified.'));
      console.log(chalk.dim('\nUsage: clawdult cp <name> <source...> <:dest>'));
      console.log(chalk.dim('  Upload:   clawdult cp mybox ./file.txt :/home/ubuntu/'));
      console.log(chalk.dim('  Download: clawdult cp mybox :/home/ubuntu/file.txt ./'));
      process.exit(1);
    }

    // Parse paths into sources and dest
    // If no path has a : prefix, all paths are local sources uploading to :/home/ubuntu/
    const hasRemote = paths.some(isRemotePath);

    let sources: string[];
    let dest: string;

    if (!hasRemote) {
      // Default: all paths are local sources, dest is remote home
      sources = paths;
      dest = ':/home/ubuntu/';
    } else {
      sources = paths.slice(0, -1);
      dest = paths[paths.length - 1];

      if (sources.length === 0) {
        console.error(chalk.red('No source paths specified.'));
        process.exit(1);
      }
    }

    // Validate: sources must all be same side, dest must be opposite
    const remoteSources = sources.filter(isRemotePath);
    const localSources = sources.filter((p) => !isRemotePath(p));

    if (remoteSources.length > 0 && localSources.length > 0) {
      console.error(chalk.red('Cannot mix local and remote source paths.'));
      process.exit(1);
    }

    const sourcesAreRemote = remoteSources.length > 0;
    const destIsRemote = isRemotePath(dest);

    if (sourcesAreRemote && destIsRemote) {
      console.error(chalk.red('Remote-to-remote copy not supported.'));
      process.exit(1);
    }

    if (!sourcesAreRemote && !destIsRemote) {
      // Shouldn't happen after default, but guard anyway
      console.error(chalk.red('No remote path specified. Prefix remote paths with :'));
      process.exit(1);
    }

    // Resolve instance connection
    const spinner = ora(`Looking up ${targetName}...`).start();
    const instance = await getManagedInstance(targetName, region);
    spinner.stop();

    if (!instance) {
      console.error(chalk.red(`Workstation '${targetName}' not found in ${region}.`));
      process.exit(1);
    }

    if (instance.state !== 'running') {
      console.error(
        chalk.red(`Workstation '${targetName}' is not running (current state: ${instance.state}).`)
      );
      console.log(chalk.dim('\nStart the instance first, or wait for it to finish starting.'));
      process.exit(1);
    }

    // Determine connection IP: prefer Tailscale, fall back to public IP
    let connectIp: string | undefined;
    let connectionMethod: 'tailscale' | 'public' = 'public';

    const tailscaleIp = await getTailscaleIP(targetName, region);

    if (options.tailscale) {
      if (!tailscaleIp) {
        console.error(chalk.red(`No Tailscale IP found for '${targetName}'.`));
        console.log(
          chalk.dim('\nThe workstation may not have Tailscale configured or is still initializing.')
        );
        process.exit(1);
      }
      connectIp = tailscaleIp;
      connectionMethod = 'tailscale';
    } else if (tailscaleIp) {
      connectIp = tailscaleIp;
      connectionMethod = 'tailscale';
    } else if (instance.publicIp) {
      connectIp = instance.publicIp;
      connectionMethod = 'public';
    }

    if (!connectIp) {
      console.error(chalk.red(`Workstation '${targetName}' has no reachable IP address.`));
      console.log(chalk.dim('\nNo Tailscale IP or public IP available.'));
      console.log(chalk.dim('The instance may still be initializing. Try again in a moment.'));
      process.exit(1);
    }

    // Resolve SSH key path: CLI option > global sshKeyPath > sshKeyPaths lookup by key name
    let identityPath = options.identity || globalConfig.sshKeyPath;
    if (
      !identityPath &&
      globalConfig.sshKeyName &&
      globalConfig.sshKeyPaths?.[globalConfig.sshKeyName]
    ) {
      identityPath = globalConfig.sshKeyPaths[globalConfig.sshKeyName];
    }

    // Build rsync command
    const sshParts = ['ssh'];
    if (identityPath) {
      sshParts.push('-i', identityPath);
    }
    sshParts.push('-p', options.port, '-o', 'StrictHostKeyChecking=accept-new');
    const sshCmd = sshParts.join(' ');

    const rsyncArgs = ['-avz'];
    if (options.progress) {
      rsyncArgs.push('--progress');
    }
    rsyncArgs.push('-e', sshCmd);

    // Replace : prefix with user@ip:
    const remotePrefix = `${options.user}@${connectIp}:`;

    const resolvedSources = sources.map((s) =>
      isRemotePath(s) ? `${remotePrefix}${s.slice(1)}` : s
    );
    const resolvedDest = isRemotePath(dest) ? `${remotePrefix}${dest.slice(1)}` : dest;

    rsyncArgs.push(...resolvedSources, resolvedDest);

    const direction = destIsRemote ? 'upload' : 'download';
    const methodLabel = connectionMethod === 'tailscale' ? 'Tailscale' : 'public IP';
    console.log(
      chalk.dim(
        `\n${direction === 'upload' ? 'Uploading to' : 'Downloading from'} ${targetName} via ${methodLabel} (${connectIp})...\n`
      )
    );

    const rsync = spawn('rsync', rsyncArgs, {
      stdio: 'inherit',
    });

    rsync.on('error', (error) => {
      console.error(chalk.red(`Failed to start rsync: ${error.message}`));
      process.exit(1);
    });

    rsync.on('exit', (code) => {
      process.exit(code || 0);
    });
  });
