import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { WorkstationConfigSchema } from '../../../schemas/config.js';
import type { GlobalConfig, GitHubAgentAccount, WorkstationType } from '../../../schemas/config.js';
import type { KeyProfile } from '../../../services/key-profiles.js';
import type { ConnectivityProfile } from '../../../services/connectivity-profiles.js';
import type { InfrastructureResult } from './wizard-steps.js';
import {
  pushKeyProfileToSSM,
  pushGitHubCredentialsToSSM,
  pushConnectivityProfileToSSM,
  pushSageMakerRoleArnToSSM,
  pushWorkstationTypeToSSM,
  getTailscaleIP,
} from '../../../services/ssm.js';
import {
  launchInstance,
  terminateInstance,
  waitForInstanceRunning,
  waitForSSHReady,
  waitForBootstrapReady,
  ensureSSHSecurityGroup,
  addSecurityGroupIngress,
  getCallerPublicIp,
  listKeyPairs,
  createKeyPair,
  getBootstrapTailscaleLogs,
  type InstanceStatus,
} from '../../../services/ec2.js';
import { saveGlobalConfig } from '../../../services/config.js';
import { ensureIamResources, deleteIamResources } from '../../../services/iam.js';

interface CreatedResources {
  iamResourcesName?: string;
  instanceId?: string;
  region: string;
}

async function cleanupOnFailure(resources: CreatedResources): Promise<void> {
  console.error(chalk.yellow('\nCleaning up partially created resources...'));

  if (resources.instanceId) {
    try {
      console.error(chalk.dim(`  Terminating instance ${resources.instanceId}...`));
      await terminateInstance(resources.instanceId, resources.region);
      console.error(chalk.dim('  Instance terminated.'));
    } catch (error) {
      console.error(
        chalk.red(
          `  Failed to terminate instance: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  if (resources.iamResourcesName) {
    try {
      console.error(chalk.dim(`  Deleting IAM resources for ${resources.iamResourcesName}...`));
      await deleteIamResources(resources.iamResourcesName, resources.region);
      console.error(chalk.dim('  IAM resources deleted.'));
    } catch (error) {
      console.error(
        chalk.red(
          `  Failed to delete IAM resources: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }
}

function showManualConnectionInstructions(
  workstationName: string,
  ip: string,
  method: 'tailscale' | 'public',
  sshKeyPath: string
): void {
  console.log(chalk.yellow('\nAuto-connect failed. To complete setup manually:\n'));

  console.log(chalk.white('  1. Connect to your workstation:'));
  console.log(chalk.dim(`     clawdult ssh ${workstationName}`));
  console.log(chalk.dim(`     (or: ssh -i ${sshKeyPath} ubuntu@${ip})\n`));

  console.log(chalk.white('  2. Run the onboarding flow:'));
  console.log(chalk.dim('     openclaw onboard\n'));
}

export async function provisionWorkstation(params: {
  name: string;
  workstationType: WorkstationType;
  infrastructure: InfrastructureResult;
  keyProfile: KeyProfile | null;
  github: GitHubAgentAccount | null;
  connectivity: ConnectivityProfile | null;
  globalConfig: GlobalConfig;
  enableAutoSSH: boolean;
}): Promise<void> {
  const {
    name,
    workstationType,
    infrastructure,
    keyProfile: selectedKeyProfile,
    github: selectedGitHubAgent,
    connectivity: selectedConnectivityProfile,
    globalConfig,
    enableAutoSSH,
  } = params;

  const config = WorkstationConfigSchema.parse({
    name,
    instanceType: infrastructure.instanceType,
    region: infrastructure.region,
    volumeSize: infrastructure.volumeSize,
  });

  // Determine SSH CIDR based on connectivity
  // If Tailscale is configured, no public SSH needed
  // Otherwise, require an explicit CIDR (from config or prompt)
  let sshCidr: string | undefined;
  const hasTailscale = selectedConnectivityProfile?.hasTailscaleKey ?? false;

  if (!hasTailscale) {
    // No Tailscale - need SSH CIDR for connectivity
    if (globalConfig.allowedSshCidr) {
      sshCidr = globalConfig.allowedSshCidr;
      console.log(chalk.dim(`Using SSH CIDR from config: ${sshCidr}\n`));
    } else {
      // Prompt user for CIDR
      console.log(chalk.yellow('\nNo Tailscale configured and no allowedSshCidr in config.'));
      console.log(chalk.dim('To find your IP, run: curl -s ifconfig.me && echo "/32"\n'));

      const cidrInput = await input({
        message: 'Enter CIDR for SSH access (e.g., your IP/32):',
        validate: (v) => {
          if (!v.trim()) return 'CIDR is required without Tailscale';
          // Basic CIDR validation
          if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(v.trim())) {
            return 'Invalid CIDR format (e.g., 1.2.3.4/32)';
          }
          return true;
        },
      });

      sshCidr = cidrInput.trim();
    }
  }

  // Track created resources for cleanup on failure
  const resources: CreatedResources = { region: config.region };

  try {
    // Ensure SSH security group exists
    const sgSpinner = ora('Ensuring SSH security group...').start();
    let securityGroupId: string;
    try {
      securityGroupId = await ensureSSHSecurityGroup(config.region, sshCidr);
      if (hasTailscale) {
        // Add temporary SSH access from user's IP for bootstrap monitoring
        try {
          const callerIp = await getCallerPublicIp();
          await addSecurityGroupIngress(
            config.region,
            securityGroupId,
            `${callerIp}/32`,
            'Bootstrap SSH access'
          );
          sgSpinner.succeed(`Security group ready (Tailscale + temporary SSH from ${callerIp})`);
        } catch {
          sgSpinner.succeed('Security group ready (Tailscale handles connectivity)');
        }
      } else {
        sgSpinner.succeed(`SSH security group ready (CIDR: ${sshCidr})`);
      }
    } catch (error) {
      sgSpinner.fail('Failed to create SSH security group');
      throw new Error(error instanceof Error ? error.message : String(error));
    }

    // Check for SSH key BEFORE creating IAM resources
    // This ensures no IAM resources are orphaned if user aborts during interactive prompts
    let sshKeyName = globalConfig.sshKeyName;

    // Resolve sshKeyPath from sshKeyPaths map if not directly set
    if (sshKeyName && !globalConfig.sshKeyPath && globalConfig.sshKeyPaths?.[sshKeyName]) {
      globalConfig.sshKeyPath = globalConfig.sshKeyPaths[sshKeyName];
    }

    if (!sshKeyName) {
      console.log(chalk.yellow('\nNo SSH key pair configured.'));

      // List existing key pairs
      const existingKeys = await listKeyPairs(config.region);

      if (existingKeys.length > 0) {
        const keyChoice = await select({
          message: 'Select an existing EC2 key pair or create a new one:',
          choices: [
            ...existingKeys.map((k) => ({ value: k, name: k })),
            { value: '__create__', name: 'Create a new key pair' },
          ],
        });

        if (keyChoice !== '__create__') {
          sshKeyName = keyChoice;

          // Prompt for local private key path if not already known
          const knownPath = globalConfig.sshKeyPaths?.[sshKeyName];
          if (knownPath) {
            console.log(chalk.dim(`  Using saved key path: ${knownPath}`));
            globalConfig.sshKeyPath = knownPath;
          } else {
            const keyPath = await input({
              message: `Path to local private key for "${sshKeyName}" (e.g., ~/.ssh/${sshKeyName}.pem):`,
              validate: async (v) => {
                if (!v.trim()) return 'Path is required to SSH into the workstation';
                const resolved = v.trim().replace(/^~/, process.env.HOME || '');
                try {
                  await fs.access(resolved);
                  return true;
                } catch {
                  return `File not found: ${resolved}`;
                }
              },
            });

            const resolvedPath = keyPath.trim().replace(/^~/, process.env.HOME || '');
            globalConfig.sshKeyPath = resolvedPath;
            globalConfig.sshKeyPaths = { ...globalConfig.sshKeyPaths, [sshKeyName]: resolvedPath };
          }

          // Save to config
          globalConfig.sshKeyName = sshKeyName;
          await saveGlobalConfig(globalConfig);
          console.log(chalk.green(`✓ Using key pair: ${sshKeyName}\n`));
        }
      }

      if (!sshKeyName) {
        // Create new key pair
        const keyPairName = await input({
          message: 'Name for new EC2 key pair:',
          default: config.name,
          validate: (v) => {
            if (!v.trim()) return 'Name is required';
            if (!/^[a-zA-Z0-9_-]+$/.test(v))
              return 'Only alphanumeric, hyphens, and underscores allowed';
            return true;
          },
        });

        const keySpinner = ora('Creating EC2 key pair...').start();
        try {
          const result = await createKeyPair(keyPairName, config.region);
          keySpinner.succeed(`Created key pair: ${result.keyName}`);
          console.log(chalk.dim(`  Private key saved to: ${result.privateKeyPath}`));

          sshKeyName = result.keyName;
          globalConfig.sshKeyName = sshKeyName;
          globalConfig.sshKeyPath = result.privateKeyPath;
          globalConfig.sshKeyPaths = {
            ...globalConfig.sshKeyPaths,
            [sshKeyName]: result.privateKeyPath,
          };
          await saveGlobalConfig(globalConfig);
        } catch (error) {
          keySpinner.fail('Failed to create key pair');
          throw new Error(error instanceof Error ? error.message : String(error));
        }
      }
    }

    // Create IAM role and instance profile AFTER SSH key selection
    // Now all interactive prompts are done - safe to create IAM resources
    const capabilities = workstationType.capabilities;
    const iamSpinner = ora('Creating IAM role and instance profile...').start();
    let instanceProfileName: string;
    try {
      const iamResources = await ensureIamResources(config.name, config.region, capabilities);
      instanceProfileName = iamResources.instanceProfileName;
      resources.iamResourcesName = config.name;

      const extraRoleNames = iamResources.extraRoles.map((r) => r.type);
      if (extraRoleNames.length > 0) {
        iamSpinner.succeed(
          `IAM role, instance profile, and ${extraRoleNames.join(', ')} role(s) ready`
        );
      } else {
        iamSpinner.succeed('IAM role and instance profile ready');
      }

      // Store extra role ARNs in SSM so the agent can discover them
      for (const extra of iamResources.extraRoles) {
        if (extra.type === 'sagemaker') {
          await pushSageMakerRoleArnToSSM(config.name, config.region, extra.roleArn);
        }
      }

      // Store workstation type in SSM
      await pushWorkstationTypeToSSM(config.name, config.region, {
        name: workstationType.name,
        capabilities: workstationType.capabilities,
        tools: workstationType.tools,
      });
    } catch (error) {
      iamSpinner.fail('Failed to create IAM resources');
      throw new Error(error instanceof Error ? error.message : String(error));
    }

    // Push secrets to SSM BEFORE launching instance (so bootstrap can read them)
    // SSM push failures are fatal - use --skip-keys, --skip-github, --skip-connectivity to bypass
    if (selectedKeyProfile) {
      const secretsSpinner = ora(
        `Pushing API keys from profile '${selectedKeyProfile.name}'...`
      ).start();
      try {
        const { pushed } = await pushKeyProfileToSSM(
          config.name,
          config.region,
          selectedKeyProfile.name
        );
        if (pushed.length > 0) {
          secretsSpinner.succeed(`Pushed ${pushed.length} API key(s) to SSM: ${pushed.join(', ')}`);
        } else {
          secretsSpinner.info('Key profile has no API keys configured');
        }
      } catch (error) {
        secretsSpinner.fail('Failed to push API keys to SSM');
        console.error(
          chalk.red(`  Error: ${error instanceof Error ? error.message : String(error)}`)
        );
        console.log(chalk.dim('  Use --skip-keys to create workstation without API keys'));
        throw new Error('Failed to push API keys to SSM');
      }
    }

    if (selectedGitHubAgent) {
      const githubSpinner = ora('Pushing GitHub credentials to SSM...').start();
      try {
        await pushGitHubCredentialsToSSM(config.name, config.region, selectedGitHubAgent);
        githubSpinner.succeed(`Pushed GitHub credentials for ${selectedGitHubAgent.username}`);
      } catch (error) {
        githubSpinner.fail('Failed to push GitHub credentials to SSM');
        console.error(
          chalk.red(`  Error: ${error instanceof Error ? error.message : String(error)}`)
        );
        console.log(
          chalk.dim('  Use --skip-github to create workstation without GitHub credentials')
        );
        throw new Error('Failed to push GitHub credentials to SSM');
      }
    }

    if (selectedConnectivityProfile) {
      const connectivitySpinner = ora(
        `Pushing connectivity profile '${selectedConnectivityProfile.name}'...`
      ).start();
      try {
        const result = await pushConnectivityProfileToSSM(
          config.name,
          config.region,
          selectedConnectivityProfile.name
        );
        const pushed: string[] = [];
        if (result.tailscale) pushed.push('Tailscale');
        if (result.openclaw) pushed.push('OpenClaw');
        if (result.messaging.pushed.length > 0) pushed.push(...result.messaging.pushed);
        if (pushed.length > 0) {
          connectivitySpinner.succeed(`Pushed connectivity config: ${pushed.join(', ')}`);
        } else {
          connectivitySpinner.info('Connectivity profile has no secrets configured');
        }
        if (result.openclawToken) {
          console.log(chalk.cyan('\n  OpenClaw Gateway Token:'));
          console.log(chalk.white(`  ${result.openclawToken}`));
          console.log(chalk.dim('  Save this token - needed to connect to the gateway.\n'));
        }
      } catch (error) {
        connectivitySpinner.fail('Failed to push connectivity profile to SSM');
        console.error(
          chalk.red(`  Error: ${error instanceof Error ? error.message : String(error)}`)
        );
        console.log(
          chalk.dim('  Use --skip-connectivity to create workstation without connectivity profile')
        );
        throw new Error('Failed to push connectivity profile to SSM');
      }
    }

    const spinner = ora('Launching EC2 instance...').start();

    // Launch the EC2 instance with metadata tags
    const launchResult = await launchInstance({
      name: config.name,
      instanceType: config.instanceType,
      region: config.region,
      volumeSize: config.volumeSize,
      securityGroupIds: [securityGroupId],
      keyName: sshKeyName,
      iamInstanceProfile: instanceProfileName,
      keyProfileName: selectedKeyProfile?.name,
      githubAgentUsername: selectedGitHubAgent?.username,
      workstationTypeName: workstationType.name,
      capabilities: workstationType.capabilities,
    });

    resources.instanceId = launchResult.instanceId;
    spinner.succeed(`Instance launched: ${launchResult.instanceId}`);

    // Track for display
    const instanceId = launchResult.instanceId;
    let publicIp: string | undefined;

    // Wait for instance to be running
    const waitSpinner = ora('Waiting for instance to start...').start();
    let lastState = '';

    try {
      const finalStatus = await waitForInstanceRunning(launchResult.instanceId, config.region, {
        maxWaitTimeSeconds: 300,
        onProgress: (status: InstanceStatus) => {
          if (status.state !== lastState) {
            lastState = status.state;
            waitSpinner.text = `Instance state: ${status.state}`;
          }
        },
      });

      waitSpinner.succeed(
        `Instance running: ${finalStatus.publicIpAddress || finalStatus.privateIpAddress || launchResult.instanceId}`
      );

      publicIp = finalStatus.publicIpAddress;

      // Wait for SSH to be ready
      if (publicIp) {
        const sshSpinner = ora('Waiting for SSH to be ready...').start();
        try {
          await waitForSSHReady(publicIp, {
            maxWaitTimeSeconds: 180,
            onProgress: (attempt) => {
              sshSpinner.text = `Waiting for SSH to be ready... (attempt ${attempt})`;
            },
          });
          sshSpinner.succeed('SSH is ready');
        } catch (error) {
          console.error(
            'clawdult: SSH readiness check failed:',
            error instanceof Error ? error.message : String(error)
          );
          sshSpinner.warn('SSH readiness check timed out');
        }

        // Wait for workstation bootstrap to complete
        if (globalConfig.sshKeyPath) {
          const bootstrapSpinner = ora('Waiting for workstation bootstrap...').start();
          try {
            await waitForBootstrapReady(publicIp, globalConfig.sshKeyPath, {
              maxWaitTimeSeconds: 600,
              onProgress: (status) => {
                bootstrapSpinner.text = status;
              },
            });
            bootstrapSpinner.succeed('Workstation fully configured');
          } catch (error) {
            console.error(
              'clawdult: bootstrap check failed:',
              error instanceof Error ? error.message : String(error)
            );
            bootstrapSpinner.warn(
              'Bootstrap check timed out - workstation may still be configuring'
            );
          }
        }
      }
    } catch (waitError) {
      waitSpinner.fail(
        `Instance failed to start: ${waitError instanceof Error ? waitError.message : String(waitError)}`
      );
      throw new Error(waitError instanceof Error ? waitError.message : String(waitError));
    }

    console.log(chalk.green('\n✓ Workstation ready!\n'));
    console.log(chalk.dim(`  Instance ID: ${instanceId}`));
    console.log(chalk.dim(`  State:       running`));
    if (publicIp) {
      console.log(chalk.dim(`  Public IP:   ${publicIp}`));
    }
    console.log();

    // Auto-SSH into workstation unless --no-ssh was passed or dry-run mode
    const canAutoSSH = enableAutoSSH && globalConfig.sshKeyPath;

    if (enableAutoSSH && !globalConfig.sshKeyPath) {
      console.log(chalk.yellow('\nAuto-SSH skipped: SSH key path not configured.'));
      console.log(chalk.dim('  To fix: clawdult config set sshKeyPath /path/to/your/key.pem\n'));
    }

    if (canAutoSSH) {
      // sshKeyPath is guaranteed defined here (checked in canAutoSSH)
      const sshKeyPath = globalConfig.sshKeyPath!;

      // Try Tailscale IP first, fall back to public IP
      let connectIp: string | undefined;
      let connectionMethod: 'tailscale' | 'public' = 'public';

      // Poll for Tailscale IP - use longer timeout when Tailscale is configured
      const maxAttempts = hasTailscale ? 60 : 5;
      const pollInterval = hasTailscale ? 5000 : 2000;
      const tailscaleSpinner = ora('Checking for Tailscale IP...').start();
      let tailscaleIp: string | null = null;
      try {
        for (let i = 0; i < maxAttempts; i++) {
          tailscaleIp = await getTailscaleIP(config.name, config.region);
          if (tailscaleIp) break;
          tailscaleSpinner.text = `Waiting for Tailscale IP... (${i + 1}/${maxAttempts})`;
          await new Promise((resolve) => setTimeout(resolve, pollInterval));
        }
      } catch {
        // Best effort - don't fail if we can't check Tailscale
      }
      tailscaleSpinner.stop();

      if (tailscaleIp) {
        connectIp = tailscaleIp;
        connectionMethod = 'tailscale';
      } else {
        if (hasTailscale) {
          console.log(chalk.yellow('\nTailscale IP not found.'));

          // Fetch actual Tailscale errors from the bootstrap log
          if (publicIp && globalConfig.sshKeyPath) {
            const logs = await getBootstrapTailscaleLogs(publicIp, globalConfig.sshKeyPath);
            if (logs) {
              console.log(chalk.yellow('\nBootstrap Tailscale log:'));
              for (const line of logs.split('\n')) {
                console.log(chalk.dim(`  ${line}`));
              }
              console.log();
            }
          }

          console.log(chalk.dim(`  Check full logs: clawdult logs ${config.name}`));
          console.log(chalk.dim(`  Retry later: clawdult ssh ${config.name}\n`));
        }
        if (publicIp) {
          if (hasTailscale) {
            console.log(chalk.yellow('Falling back to public IP for initial connection.\n'));
          }
          connectIp = publicIp;
          connectionMethod = 'public';
        }
      }

      if (connectIp) {
        const methodLabel = connectionMethod === 'tailscale' ? 'Tailscale' : 'public IP';
        console.log(chalk.cyan(`Connecting via ${methodLabel} to run openclaw onboard...\n`));

        const sshArgs: string[] = [
          '-t', // Force TTY allocation for interactive prompts
          '-i',
          sshKeyPath,
          '-p',
          '22',
          '-o',
          'StrictHostKeyChecking=accept-new',
          '-o',
          'ConnectTimeout=30',
          `ubuntu@${connectIp}`,
          'openclaw onboard',
        ];

        try {
          const exitCode = await new Promise<number>((resolve, reject) => {
            const ssh = spawn('ssh', sshArgs, { stdio: 'inherit' });
            ssh.on('error', reject);
            ssh.on('exit', (code, signal) => {
              // Signal termination (e.g., Ctrl+C) should exit cleanly
              if (signal) {
                process.exit(128 + (signal === 'SIGINT' ? 2 : 1));
              }
              resolve(code ?? 0);
            });
          });

          if (exitCode === 0) {
            return; // Success - we're done
          }
          // Non-zero exit - fall through to show manual instructions
          console.log(chalk.yellow(`\nSSH command exited with code ${exitCode}\n`));
        } catch (error) {
          console.log(
            chalk.yellow(
              `\nCould not connect: ${error instanceof Error ? error.message : String(error)}\n`
            )
          );
        }

        // Show manual connection instructions
        showManualConnectionInstructions(config.name, connectIp, connectionMethod, sshKeyPath);
      } else {
        console.log(chalk.yellow('No reachable IP found for auto-SSH.\n'));
        console.log(chalk.cyan('To connect later:\n'));
        console.log(
          chalk.dim('  Use: ') +
            chalk.white(`clawdult ssh ${config.name}`) +
            chalk.dim(' then run ') +
            chalk.white('openclaw onboard\n')
        );
      }
    } else {
      // Auto-SSH was skipped - show manual instructions
      console.log(chalk.cyan('To complete setup:\n'));
      console.log(chalk.white('  1. Connect to your workstation:'));
      console.log(chalk.dim(`     clawdult ssh ${config.name}\n`));
      console.log(chalk.white('  2. Run the onboarding flow:'));
      console.log(chalk.dim('     openclaw onboard\n'));
    }
  } catch (error) {
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
    await cleanupOnFailure(resources);
    process.exit(1);
  }
}
