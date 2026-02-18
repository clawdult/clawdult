import { Command } from 'commander';
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import { WorkstationConfigSchema } from '../../../schemas/config.js';
import { loadGlobalConfig } from '../../../services/config.js';
import type { KeyProfile } from '../../../services/key-profiles.js';
import { getConfiguredKeysDescription } from '../../../services/key-profiles.js';
import type { ConnectivityProfile } from '../../../services/connectivity-profiles.js';
import {
  getConfiguredDescription as getConnectivityDescription,
  validateConnectivity,
} from '../../../services/connectivity-profiles.js';
import type { GitHubAgentAccount } from '../../../schemas/config.js';
import { GO_BACK } from '../../utils/wizard.js';
import { requireAwsCredentials } from '../../utils/require-aws.js';
import {
  handleKeyProfile,
  handleConnectivityProfile,
  handleGitHubAgent,
  handleInfrastructure,
  type InfrastructureResult,
} from './wizard-steps.js';
import { provisionWorkstation } from './provisioner.js';

const ADJECTIVES = [
  'swift',
  'clever',
  'quiet',
  'bold',
  'calm',
  'eager',
  'fierce',
  'gentle',
  'happy',
  'jolly',
  'keen',
  'lively',
  'merry',
  'noble',
  'proud',
  'quick',
  'sharp',
  'steady',
  'bright',
  'cosmic',
  'dapper',
  'fancy',
  'grand',
  'humble',
];

const NOUNS = [
  'fox',
  'owl',
  'wolf',
  'bear',
  'hawk',
  'deer',
  'lynx',
  'crow',
  'hare',
  'orca',
  'seal',
  'moth',
  'wren',
  'pike',
  'crab',
  'wasp',
  'frog',
  'newt',
  'goat',
  'dove',
  'swan',
  'rook',
  'kite',
  'mink',
];

function generateRandomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const suffix = Math.floor(Math.random() * 1000);
  return `${adj}-${noun}-${suffix}`;
}

export const createCommand = new Command('create')
  .description('Provision a new EC2 workstation for an AI agent')
  .argument('[name]', 'Name for the workstation (random if not provided)')
  .option('-t, --type <type>', 'Instance type (e.g., t3.medium)')
  .option('-r, --region <region>', 'AWS region')
  .option('-s, --volume-size <size>', 'EBS volume size in GB', parseInt)
  .option('--skip-github', 'Skip GitHub agent account step')
  .option('--skip-keys', 'Skip API key profile step')
  .option('--key-profile <name>', 'Use a specific key profile')
  .option('--skip-connectivity', 'Skip connectivity profile step')
  .option('--connectivity-profile <name>', 'Use a specific connectivity profile')
  .option('--dry-run', 'Show what would be created without actually creating')
  .option('--no-ssh', 'Skip auto-SSH into workstation after creation')
  .action(async (providedName: string | undefined, options) => {
    const name = providedName ?? generateRandomName();
    console.log(chalk.bold('\n┌──────────────────────────────────────────────────────────────┐'));
    console.log(chalk.bold('│              CLAWDULT WORKSTATION PROVISIONER                │'));
    console.log(chalk.bold('│         Create a new EC2 workstation for an AI agent         │'));
    console.log(chalk.bold('└──────────────────────────────────────────────────────────────┘\n'));

    // Check AWS credentials before proceeding
    await requireAwsCredentials();

    const globalConfig = await loadGlobalConfig();

    // Validate name
    const nameResult = WorkstationConfigSchema.shape.name.safeParse(name);
    if (!nameResult.success) {
      console.error(
        chalk.red(
          'Invalid workstation name. Must be lowercase alphanumeric with hyphens, 2-63 characters.'
        )
      );
      process.exit(1);
    }

    // Build step list based on what's not skipped
    type StepName = 'keyProfile' | 'github' | 'connectivity' | 'infrastructure';
    const steps: StepName[] = [];
    if (!options.skipKeys) steps.push('keyProfile');
    if (!options.skipGithub) steps.push('github');
    if (!options.skipConnectivity) steps.push('connectivity');
    steps.push('infrastructure');

    // Accumulated state from each step (object so TypeScript doesn't narrow through closures)
    const wizardState = {
      keyProfile: null as KeyProfile | null,
      github: null as GitHubAgentAccount | null,
      connectivity: null as ConnectivityProfile | null,
      infrastructure: null as InfrastructureResult | null,
    };

    // Runs one wizard step; returns true to advance, false to go back
    async function runStep(idx: number): Promise<boolean> {
      const stepName = steps[idx];
      const displayNum = idx + 1;
      const allowBack = idx > 0;

      switch (stepName) {
        case 'keyProfile': {
          console.log(chalk.bold(`STEP ${displayNum}: API Key Profile\n`));
          const result = await handleKeyProfile(options.keyProfile, allowBack);
          if (result === GO_BACK) return false;
          wizardState.keyProfile = result;
          return true;
        }
        case 'github': {
          console.log(chalk.bold(`STEP ${displayNum}: GitHub Agent Account\n`));
          const result = await handleGitHubAgent(allowBack);
          if (result === GO_BACK) return false;
          wizardState.github = result;
          return true;
        }
        case 'connectivity': {
          console.log(chalk.bold(`STEP ${displayNum}: Connectivity Profile\n`));
          const result = await handleConnectivityProfile(options.connectivityProfile, allowBack);
          if (result === GO_BACK) return false;
          wizardState.connectivity = result;
          return true;
        }
        case 'infrastructure': {
          console.log(chalk.bold(`STEP ${displayNum}: Infrastructure\n`));
          const result = await handleInfrastructure(options, globalConfig, allowBack);
          if (result === GO_BACK) return false;
          wizardState.infrastructure = result;
          return true;
        }
        default:
          return true;
      }
    }

    // Step loop with back navigation
    let stepIndex = 0;
    while (stepIndex < steps.length) {
      if (await runStep(stepIndex)) {
        stepIndex++;
      } else {
        stepIndex--;
      }
    }

    // Summary and confirmation loop (user can go back to change settings)
    wizardConfirm: while (true) {
      console.log(chalk.dim('\nConfiguration:'));
      console.log(chalk.dim(`  Name:          ${name}`));
      console.log(chalk.dim(`  Instance Type: ${wizardState.infrastructure!.instanceType}`));
      console.log(chalk.dim(`  Region:        ${wizardState.infrastructure!.region}`));
      console.log(chalk.dim(`  Volume Size:   ${wizardState.infrastructure!.volumeSize} GB`));
      console.log(
        chalk.dim(
          `  Key Profile:   ${wizardState.keyProfile ? `${wizardState.keyProfile.name} (${getConfiguredKeysDescription(wizardState.keyProfile)})` : 'None'}`
        )
      );
      console.log(
        chalk.dim(`  GitHub Agent:  ${wizardState.github ? wizardState.github.username : 'None'}`)
      );
      console.log(
        chalk.dim(
          `  Connectivity:  ${wizardState.connectivity ? `${wizardState.connectivity.name} (${getConnectivityDescription(wizardState.connectivity)})` : 'None'}\n`
        )
      );

      // Validate connectivity profile
      if (wizardState.connectivity) {
        const validation = validateConnectivity(
          wizardState.connectivity,
          !!globalConfig.allowedSshCidr
        );

        if (!validation.valid) {
          console.log(chalk.red('\nConnectivity validation failed:'));
          for (const error of validation.errors) {
            console.log(chalk.red(`  • ${error}`));
          }
          process.exit(1);
        }
      }

      if (options.dryRun) {
        console.log(chalk.yellow('Dry run mode - no resources will be created.\n'));
        console.log(chalk.green('✓ Configuration is valid'));
        return;
      }

      const confirmAction = await select({
        message: 'Create this workstation?',
        choices: [
          { value: 'yes', name: 'Yes, create it' },
          { value: 'back', name: '<< Go back to change settings' },
          { value: 'cancel', name: 'Cancel' },
        ],
      });

      if (confirmAction === 'cancel') {
        console.log(chalk.yellow('\nAborted.'));
        return;
      }

      if (confirmAction === 'back') {
        // Re-enter step loop from the last step, allowing back navigation
        stepIndex = steps.length - 1;
        while (stepIndex >= 0 && stepIndex < steps.length) {
          if (await runStep(stepIndex)) {
            stepIndex++;
          } else {
            stepIndex--;
          }
        }
        continue wizardConfirm;
      }

      break;
    }

    // Use explicit default since Commander.js --no-* options may be undefined
    const enableAutoSSH = options.ssh ?? true;

    await provisionWorkstation({
      name,
      infrastructure: wizardState.infrastructure!,
      keyProfile: wizardState.keyProfile,
      github: wizardState.github,
      connectivity: wizardState.connectivity,
      globalConfig,
      enableAutoSSH,
    });
  });
