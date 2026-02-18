import chalk from 'chalk';
import ora from 'ora';
import { select, confirm } from '@inquirer/prompts';
import { execSync, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLatestClawdultAmi, ensurePackerSecurityGroup } from '../../../services/ec2.js';

export function openUrl(url: string): void {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      execFileSync('open', [url], { stdio: 'ignore' });
    } else if (platform === 'linux') {
      execFileSync('xdg-open', [url], { stdio: 'ignore' });
    } else if (platform === 'win32') {
      execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    }
  } catch {
    console.log(chalk.dim('Could not open browser. Please open the URL manually.'));
  }
}

export function copyToClipboard(text: string): void {
  try {
    const platform = process.platform;
    if (platform === 'darwin') {
      execSync('pbcopy', { input: text });
    } else if (platform === 'linux') {
      execSync('xclip -selection clipboard', { input: text });
    } else if (platform === 'win32') {
      execSync('clip', { input: text });
    }
  } catch {
    console.log(chalk.dim('Could not copy to clipboard. Please copy manually.'));
  }
}

function checkPackerInstalled(): boolean {
  try {
    execSync('packer --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getPackerVersion(): string {
  try {
    return execSync('packer --version', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getPackerDir(): string {
  // Get the directory of this file, then navigate to packer/
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.resolve(__dirname, '..', '..', '..', '..', 'packer');
}

async function runPackerBuild(
  region: string,
  awsProfile: string
): Promise<{ success: boolean; amiId?: string; error?: string }> {
  const packerDir = getPackerDir();
  const packerFile = path.join(packerDir, 'clawdult-ami.pkr.hcl');

  return new Promise((resolve) => {
    const proc = spawn('packer', ['build', '-var', `aws_region=${region}`, packerFile], {
      cwd: packerDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AWS_PROFILE: awsProfile },
    });

    let _stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const line = data.toString();
      _stdout += line;
      // Print progress to console
      process.stdout.write(chalk.dim(line));
    });

    proc.stderr.on('data', (data) => {
      const line = data.toString();
      stderr += line;
      process.stderr.write(chalk.dim(line));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        // Try to extract AMI ID from manifest.json
        try {
          const manifestPath = path.join(packerDir, 'manifest.json');
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          const amiId = manifest.builds?.[0]?.artifact_id?.split(':')[1];
          resolve({ success: true, amiId });
        } catch {
          // Manifest parsing failed, but build succeeded
          resolve({ success: true });
        }
      } else {
        resolve({ success: false, error: stderr || `Packer exited with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

export async function runAmiBuildPhase(region: string, profileName: string): Promise<void> {
  console.log(
    chalk.dim('Building a custom AMI with OpenClaw and development tools pre-installed.')
  );
  console.log(chalk.dim('This is required for workstation creation.\n'));

  // Check for existing AMI
  const spinner = ora('Checking for existing Clawdult AMI...').start();
  const existingAmi = await getLatestClawdultAmi(region);

  if (existingAmi) {
    spinner.succeed(`Clawdult AMI already exists: ${existingAmi}`);

    const rebuildChoice = await select({
      message: 'What would you like to do?',
      choices: [
        { value: 'keep', name: 'Keep existing AMI (recommended)' },
        { value: 'rebuild', name: 'Build a new AMI (takes 10-15 minutes)' },
      ],
    });

    if (rebuildChoice === 'keep') {
      console.log(chalk.dim('\nUsing existing AMI.\n'));
      return;
    }
  } else {
    spinner.info('No Clawdult AMI found');
  }

  // Check Packer installation
  if (!checkPackerInstalled()) {
    console.log(chalk.red('\n✗ Packer is not installed'));
    console.log(chalk.dim('\nInstall Packer to build the AMI:'));
    console.log(chalk.dim('  macOS: brew install packer'));
    console.log(chalk.dim('  Linux: https://developer.hashicorp.com/packer/install'));
    console.log();
    console.log(chalk.yellow('Skipping AMI build. You can build manually with:'));
    console.log(chalk.dim('  cd packer && packer build clawdult-ami.pkr.hcl\n'));
    return;
  }

  const packerVersion = getPackerVersion();
  console.log(chalk.green('✓') + ` Packer installed: ${chalk.dim(packerVersion)}`);

  // Confirm build
  const confirmBuild = await confirm({
    message: 'Build Clawdult AMI now? (This takes 10-15 minutes)',
    default: true,
  });

  if (!confirmBuild) {
    console.log(chalk.yellow('\nSkipping AMI build. You can build later with:'));
    console.log(chalk.dim('  cd packer && packer build clawdult-ami.pkr.hcl\n'));
    return;
  }

  // Ensure Packer security group exists (Packer uses security_group_filter to find it)
  const sgSpinner = ora('Ensuring Packer security group exists...').start();
  try {
    const packerSgId = await ensurePackerSecurityGroup(region);
    sgSpinner.succeed(`Using security group: ${packerSgId}`);
  } catch (error) {
    sgSpinner.fail(
      `Failed to create security group: ${error instanceof Error ? error.message : String(error)}`
    );
    console.log(chalk.yellow('\nYou may need to create the security group manually.'));
    return;
  }

  // Initialize Packer plugins
  console.log(chalk.dim('\nInitializing Packer plugins...'));
  try {
    execSync('packer init .', { cwd: getPackerDir(), stdio: 'inherit' });
  } catch {
    console.log(chalk.yellow('Packer init failed - plugins may already be installed'));
  }

  // Run Packer build
  console.log(chalk.bold('\nBuilding AMI...\n'));
  const result = await runPackerBuild(region, profileName);

  if (result.success) {
    console.log();
    if (result.amiId) {
      console.log(chalk.green.bold(`✓ AMI built successfully: ${result.amiId}`));
    } else {
      console.log(chalk.green.bold('✓ AMI built successfully'));
    }
    console.log();
  } else {
    console.log();
    console.log(chalk.red(`✗ AMI build failed: ${result.error}`));
    console.log(chalk.dim('\nYou can retry manually with:'));
    console.log(chalk.dim('  cd packer && packer build clawdult-ami.pkr.hcl\n'));
  }
}
