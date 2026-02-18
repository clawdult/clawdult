import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Check if AWS CLI is installed
 */
export function checkAwsCliInstalled(): boolean {
  try {
    const result = spawnSync('aws', ['--version'], { encoding: 'utf-8' });
    return result.status === 0;
  } catch (error) {
    console.error(
      'clawdult: failed to check AWS CLI:',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

/**
 * Check if Homebrew is installed (macOS)
 */
function checkBrewInstalled(): boolean {
  try {
    const result = spawnSync('brew', ['--version'], { encoding: 'utf-8' });
    return result.status === 0;
  } catch (error) {
    console.error(
      'clawdult: failed to check Homebrew:',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

/**
 * Get the system architecture
 */
function getArchitecture(): 'x86_64' | 'aarch64' {
  const arch = process.arch;
  if (arch === 'arm64' || arch === 'arm') {
    return 'aarch64';
  }
  return 'x86_64';
}

/**
 * Attempt to install AWS CLI automatically
 * Returns true if installation succeeded
 */
export async function installAwsCli(): Promise<boolean> {
  const platform = process.platform;
  const arch = getArchitecture();

  console.log(`  Detected: ${platform} (${arch})`);

  if (platform === 'darwin') {
    // macOS - use Homebrew
    if (!checkBrewInstalled()) {
      console.log('  Homebrew not found, cannot auto-install AWS CLI');
      return false;
    }

    console.log('  Installing AWS CLI via Homebrew...');
    try {
      const result = spawnSync('brew', ['install', 'awscli'], {
        encoding: 'utf-8',
        stdio: 'inherit',
      });
      return result.status === 0;
    } catch (error) {
      console.error(
        'clawdult: failed to install AWS CLI via Homebrew:',
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  } else if (platform === 'linux') {
    // Linux - download and install with architecture detection
    const downloadUrl =
      arch === 'aarch64'
        ? 'https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip'
        : 'https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip';

    console.log(`  Downloading AWS CLI for ${arch}...`);
    try {
      const tmpDir = os.tmpdir();
      const zipPath = `${tmpDir}/awscliv2.zip`;
      const extractDir = `${tmpDir}/aws`;

      // Download
      execFileSync('curl', ['-sL', downloadUrl, '-o', zipPath], {
        encoding: 'utf-8',
        stdio: 'inherit',
      });

      // Extract
      console.log('  Extracting...');
      execFileSync('unzip', ['-q', '-o', zipPath, '-d', tmpDir], { encoding: 'utf-8' });

      // Install (may need sudo for /usr/local/bin)
      console.log('  Installing...');
      try {
        execFileSync(path.join(extractDir, 'install'), ['--update'], {
          encoding: 'utf-8',
          stdio: 'inherit',
        });
      } catch {
        // Try with sudo if direct install fails
        console.log('  Retrying with sudo...');
        execFileSync('sudo', [path.join(extractDir, 'install'), '--update'], {
          encoding: 'utf-8',
          stdio: 'inherit',
        });
      }

      // Cleanup
      await fs.rm(zipPath, { force: true });
      await fs.rm(extractDir, { recursive: true, force: true });

      return checkAwsCliInstalled();
    } catch (error) {
      console.log(
        `  Installation failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  // Windows or unsupported platform
  console.log(`  Automatic installation not supported on ${platform}`);
  return false;
}

/**
 * Get AWS CLI version
 */
export function getAwsCliVersion(): string | null {
  try {
    const result = spawnSync('aws', ['--version'], { encoding: 'utf-8' });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
    return null;
  } catch (error) {
    console.error(
      'clawdult: failed to get AWS CLI version:',
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}
