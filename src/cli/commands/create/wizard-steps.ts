import { select, input } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { InstanceTypeSchema, RegionSchema } from '../../../schemas/config.js';
import type { GitHubAgentAccount, GlobalConfig, WorkstationType } from '../../../schemas/config.js';
import { GO_BACK, type StepResult } from '../../utils/wizard.js';
import {
  listKeyProfiles,
  getConfiguredKeysDescription,
  type KeyProfile,
} from '../../../services/key-profiles.js';
import {
  listConnectivityProfiles,
  getConnectivityProfile,
  getConfiguredDescription as getConnectivityDescription,
  type ConnectivityProfile,
} from '../../../services/connectivity-profiles.js';
import { createProfileInteractive } from '../profiles/keys.js';
import {
  createProfileInteractive as createConnectivityProfileInteractive,
  editProfileInteractive as editConnectivityProfileInteractive,
} from '../profiles/connectivity.js';
import { listAgentAccounts, getAgentToken, validateToken } from '../../../services/github-agent.js';
import { createNewGitHubAgent, promptForToken } from './github-flow.js';
import { listWorkstationTypes, getWorkstationType } from '../../../services/workstation-types.js';

export async function handleWorkstationType(
  providedType?: string,
  allowBack = false
): Promise<StepResult<WorkstationType>> {
  if (providedType) {
    const wsType = await getWorkstationType(providedType);
    if (!wsType) {
      console.log(chalk.red(`Workstation type '${providedType}' not found.\n`));
      const allTypes = await listWorkstationTypes();
      console.log(chalk.dim(`Available types: ${allTypes.map((t) => t.name).join(', ')}`));
      process.exit(1);
    }
    console.log(
      chalk.green('✓') + ` Using workstation type: ${wsType.name} - ${wsType.description}\n`
    );
    return wsType;
  }

  const types = await listWorkstationTypes();
  const choices = [
    ...types.map((t) => ({
      value: t.name,
      name: `${t.name} - ${t.description}${t.capabilities.length > 0 ? ` [${t.capabilities.join(', ')}]` : ''}`,
    })),
    ...(allowBack ? [{ value: '__back__', name: '<< Go back' }] : []),
  ];

  const selection = await select({
    message: 'Select workstation type:',
    choices,
    default: 'general-purpose',
  });

  if (selection === '__back__') return GO_BACK;

  const wsType = types.find((t) => t.name === selection)!;
  console.log(chalk.green('✓') + ` Workstation type: ${wsType.name}\n`);
  return wsType;
}

export interface InfrastructureResult {
  instanceType: string;
  region: string;
  volumeSize: number;
}

export async function handleKeyProfile(
  providedProfile?: string,
  allowBack = false
): Promise<StepResult<KeyProfile | null>> {
  // If a profile was specified via CLI option, use it
  if (providedProfile) {
    const { getKeyProfile } = await import('../../../services/key-profiles.js');
    const profile = await getKeyProfile(providedProfile);
    if (!profile) {
      console.log(chalk.red(`Key profile '${providedProfile}' not found.\n`));
      process.exit(1);
    }
    console.log(
      chalk.green('✓') +
        ` Using key profile: ${profile.name} (${getConfiguredKeysDescription(profile)})\n`
    );
    return profile;
  }

  const profiles = await listKeyProfiles();

  if (profiles.length > 0) {
    // Show existing profiles
    const choices = [
      ...profiles.map((p) => ({
        value: p.name,
        name: `${p.name} (${getConfiguredKeysDescription(p)})${p.description ? ` - ${p.description}` : ''}`,
      })),
      { value: '__new__', name: 'Create new key profile' },
      { value: '__skip__', name: 'Skip (continue without API keys)' },
      ...(allowBack ? [{ value: '__back__', name: '<< Go back' }] : []),
    ];

    const selection = await select({
      message: 'Select an API key profile:',
      choices,
    });

    if (selection === '__back__') return GO_BACK;

    if (selection === '__skip__') {
      console.log(chalk.dim('Continuing without API keys\n'));
      return null;
    }

    if (selection !== '__new__') {
      const profile = profiles.find((p) => p.name === selection)!;
      console.log(chalk.green('✓') + ` Using key profile: ${profile.name}\n`);
      return profile;
    }
  } else {
    // No existing profiles
    const action = await select({
      message: 'No API key profiles found. Would you like to:',
      choices: [
        { value: 'create', name: 'Create a new key profile' },
        { value: 'skip', name: 'Skip (continue without API keys)' },
        ...(allowBack ? [{ value: '__back__', name: '<< Go back' }] : []),
      ],
    });

    if (action === '__back__') return GO_BACK;

    if (action === 'skip') {
      console.log(chalk.dim('Continuing without API keys\n'));
      return null;
    }
  }

  // Create new profile
  const profile = await createProfileInteractive();
  return profile;
}

export async function handleConnectivityProfile(
  providedProfile?: string,
  allowBack = false
): Promise<StepResult<ConnectivityProfile | null>> {
  // If a profile was specified via CLI option, use it
  if (providedProfile) {
    const profile = await getConnectivityProfile(providedProfile);
    if (!profile) {
      console.log(chalk.red(`Connectivity profile '${providedProfile}' not found.\n`));
      process.exit(1);
    }
    console.log(
      chalk.green('✓') +
        ` Using connectivity profile: ${profile.name} (${getConnectivityDescription(profile)})\n`
    );
    return profile;
  }

  const profiles = await listConnectivityProfiles();

  if (profiles.length > 0) {
    // Show existing profiles
    const choices = [
      ...profiles.map((p) => ({
        value: p.name,
        name: `${p.name} (${getConnectivityDescription(p)})${p.description ? ` - ${p.description}` : ''}`,
      })),
      { value: '__new__', name: 'Create new connectivity profile' },
      { value: '__skip__', name: 'Skip (continue without connectivity)' },
      ...(allowBack ? [{ value: '__back__', name: '<< Go back' }] : []),
    ];

    const selection = await select({
      message: 'Select a connectivity profile:',
      choices,
    });

    if (selection === '__back__') return GO_BACK;

    if (selection === '__skip__') {
      console.log(chalk.dim('Continuing without connectivity\n'));
      return null;
    }

    if (selection !== '__new__') {
      const profile = profiles.find((p) => p.name === selection)!;

      // Ask if they want to use as-is or edit
      const action = await select({
        message: `Use "${profile.name}" as-is or edit it?`,
        choices: [
          { value: 'use', name: `Use as-is (${getConnectivityDescription(profile)})` },
          { value: 'edit', name: 'Edit this profile' },
        ],
      });

      if (action === 'use') {
        console.log(chalk.green('✓') + ` Using connectivity profile: ${profile.name}\n`);
        return profile;
      }

      // Edit the profile
      return await editConnectivityProfileInteractive(profile);
    }
  } else {
    // No existing profiles
    const action = await select({
      message: 'No connectivity profiles found. Would you like to:',
      choices: [
        { value: 'create', name: 'Create a new connectivity profile' },
        { value: 'skip', name: 'Skip (continue without connectivity)' },
        ...(allowBack ? [{ value: '__back__', name: '<< Go back' }] : []),
      ],
    });

    if (action === '__back__') return GO_BACK;

    if (action === 'skip') {
      console.log(chalk.dim('Continuing without connectivity\n'));
      return null;
    }
  }

  // Create new profile
  return await createConnectivityProfileInteractive();
}

export async function handleGitHubAgent(
  allowBack: boolean
): Promise<StepResult<GitHubAgentAccount | null>> {
  const accounts = await listAgentAccounts();

  if (accounts.length > 0) {
    // Show existing accounts
    const choices = [
      ...accounts.map((a) => ({
        value: a.username,
        name: `${a.username} (${a.email})${a.description ? ` - ${a.description}` : ''}`,
      })),
      { value: '__new__', name: 'Create new GitHub agent account' },
      { value: '__skip__', name: 'Skip (continue without GitHub account)' },
      ...(allowBack ? [{ value: '__back__', name: '<< Go back' }] : []),
    ];

    const selection = await select({
      message: 'Select a GitHub agent account:',
      choices,
    });

    if (selection === '__back__') return GO_BACK;

    if (selection === '__skip__') {
      console.log(chalk.dim('Continuing without GitHub agent account\n'));
      return null;
    }

    if (selection !== '__new__') {
      // Verify token is still valid
      const account = accounts.find((a) => a.username === selection)!;
      const token = await getAgentToken(account.username);

      if (!token) {
        console.log(
          chalk.yellow(`No token found for ${account.username}. Please provide a new one.`)
        );
        const newToken = await promptForToken(account.username);
        if (!newToken) {
          console.log(chalk.dim('Skipping GitHub agent account\n'));
          return null;
        }
      } else {
        const spinner = ora('Verifying token...').start();
        try {
          await validateToken(token);
          spinner.succeed(`Token valid for ${account.username}`);
          console.log();
          return account;
        } catch {
          spinner.fail('Token expired or invalid');
          console.log(chalk.yellow('Please provide a new token.'));
          const newToken = await promptForToken(account.username);
          if (!newToken) {
            console.log(chalk.dim('Skipping GitHub agent account\n'));
            return null;
          }
        }
      }

      console.log(chalk.green('✓') + ` Using GitHub account: ${account.username}\n`);
      return account;
    }
  } else {
    // No existing accounts
    const action = await select({
      message: 'No GitHub agent accounts found. Would you like to:',
      choices: [
        { value: 'create', name: 'Create a new GitHub agent account' },
        { value: 'skip', name: 'Skip (continue without)' },
        ...(allowBack ? [{ value: '__back__', name: '<< Go back' }] : []),
      ],
    });

    if (action === '__back__') return GO_BACK;

    if (action === 'skip') {
      console.log(chalk.dim('Continuing without GitHub agent account\n'));
      return null;
    }
  }

  // Create new account flow
  return await createNewGitHubAgent();
}

const instanceTypeDescriptions: Record<string, string> = {
  't3.micro': '1 vCPU, 1GB RAM - limited performance',
  't3.small': '2 vCPU, 2GB RAM - basic',
  't3.medium': '2 vCPU, 4GB RAM - recommended',
  't3.large': '2 vCPU, 8GB RAM',
  't3.xlarge': '4 vCPU, 16GB RAM',
  'm6i.large': '2 vCPU, 8GB RAM',
  'm6i.xlarge': '4 vCPU, 16GB RAM',
};

export async function handleInfrastructure(
  options: { type?: string; region?: string; volumeSize?: number },
  globalConfig: GlobalConfig,
  allowBack: boolean
): Promise<StepResult<InfrastructureResult>> {
  // Instance type selection (first prompt gets the back option)
  const instanceType =
    options.type ||
    (await select({
      message: 'Select instance type:',
      choices: [
        ...InstanceTypeSchema.options.map((t) => ({
          value: t,
          name: instanceTypeDescriptions[t] ? `${t} (${instanceTypeDescriptions[t]})` : t,
        })),
        ...(allowBack ? [{ value: '__back__', name: '<< Go back' }] : []),
      ],
      default: globalConfig.defaultInstanceType,
    }));

  if (instanceType === '__back__') return GO_BACK;

  // Show warning if small instance selected
  if (instanceType === 't3.micro') {
    console.log(chalk.yellow('\nWarning: t3.micro has limited performance (1 vCPU, 1GB RAM).'));
    console.log(chalk.yellow('  AI agents may run slowly or fail with memory-intensive tasks.'));
    console.log(chalk.yellow('  Consider t3.medium or larger for production use.\n'));
  }

  const region =
    options.region ||
    (await select({
      message: 'Select AWS region:',
      choices: RegionSchema.options.map((r) => ({ value: r, name: r })),
      default: globalConfig.defaultRegion,
    }));

  const volumeSize: number =
    options.volumeSize ??
    parseInt(
      await input({
        message: 'EBS volume size (GB):',
        default: String(globalConfig.defaultVolumeSize),
        validate: (v) => {
          const n = parseInt(v);
          if (isNaN(n) || n < 20 || n > 500) {
            return 'Must be between 20 and 500 GB';
          }
          return true;
        },
      })
    );

  return { instanceType, region, volumeSize };
}
