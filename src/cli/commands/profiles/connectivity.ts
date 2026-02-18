import { Command } from 'commander';
import { input, password, confirm, checkbox, select } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import {
  listConnectivityProfiles,
  getConnectivityProfile,
  createConnectivityProfile,
  saveConnectivityProfile,
  deleteConnectivityProfile,
  setProfileSecret,
  getConfiguredDescription,
  type ConnectivityProfile,
  type GatewayMode,
  type DmPolicy,
} from '../../../services/connectivity-profiles.js';
import { clickableUrl } from '../../utils/terminal-link.js';
import {
  DEFAULT_OPENCLAW_MODEL,
  getModelChoices,
  isCustomSentinel,
  isDefaultSentinel,
  MODEL_ID_PATTERN,
} from '../../../services/openclaw-models.js';

export const connectivityCommand = new Command('connectivity')
  .description('Manage connectivity profiles (Tailscale, messaging channels)')
  .action(async () => {
    // Default action: list profiles or offer to create one
    const profiles = await listConnectivityProfiles();

    if (profiles.length === 0) {
      console.log(chalk.dim('\nNo connectivity profiles configured.\n'));
      const create = await confirm({
        message: 'Would you like to create one now?',
        default: true,
      });
      if (create) {
        await createProfileInteractive();
      }
      return;
    }

    console.log(chalk.bold('\nConnectivity Profiles:\n'));
    for (const profile of profiles) {
      const desc = getConfiguredDescription(profile);
      console.log(`  ${chalk.cyan(profile.name)}`);
      console.log(chalk.dim(`    ${desc}`));
      if (profile.description) {
        console.log(chalk.dim(`    ${profile.description}`));
      }
    }
    console.log();
    console.log(chalk.dim('Commands:'));
    console.log(chalk.dim('  clawdult profiles connectivity create [name]  Create a new profile'));
    console.log(
      chalk.dim('  clawdult profiles connectivity edit <name>    Edit an existing profile')
    );
    console.log(chalk.dim('  clawdult profiles connectivity delete <name>  Delete a profile'));
    console.log();
  });

connectivityCommand
  .command('list')
  .description('List all connectivity profiles')
  .action(async () => {
    const profiles = await listConnectivityProfiles();

    if (profiles.length === 0) {
      console.log(chalk.dim('\nNo connectivity profiles configured.'));
      console.log(chalk.dim('Create one with: clawdult profiles connectivity create [name]\n'));
      return;
    }

    console.log(chalk.bold('\nConnectivity Profiles:\n'));
    for (const profile of profiles) {
      const desc = getConfiguredDescription(profile);
      console.log(`  ${chalk.cyan(profile.name)}`);
      console.log(chalk.dim(`    ${desc}`));
      if (profile.description) {
        console.log(chalk.dim(`    ${profile.description}`));
      }
    }
    console.log();
  });

connectivityCommand
  .command('create [name]')
  .description('Create a new connectivity profile')
  .action(async (providedName?: string) => {
    await createProfileInteractive(providedName);
  });

connectivityCommand
  .command('edit <name>')
  .description('Edit an existing connectivity profile')
  .action(async (name: string) => {
    const profile = await getConnectivityProfile(name);
    if (!profile) {
      console.log(chalk.red(`\nConnectivity profile '${name}' not found.\n`));
      return;
    }

    await editProfileInteractive(profile);
  });

connectivityCommand
  .command('delete <name>')
  .description('Delete a connectivity profile')
  .action(async (name: string) => {
    const profile = await getConnectivityProfile(name);
    if (!profile) {
      console.log(chalk.red(`\nConnectivity profile '${name}' not found.\n`));
      return;
    }

    const confirmed = await confirm({
      message: `Delete connectivity profile '${name}'? This cannot be undone.`,
      default: false,
    });

    if (!confirmed) {
      console.log(chalk.yellow('\nCancelled.\n'));
      return;
    }

    const spinner = ora('Deleting connectivity profile...').start();
    await deleteConnectivityProfile(name);
    spinner.succeed(`Connectivity profile '${name}' deleted.`);
    console.log();
  });

async function createProfileInteractive(
  providedName?: string
): Promise<ConnectivityProfile | null> {
  console.log(chalk.bold('\nCreate Connectivity Profile\n'));
  console.log(chalk.dim('A connectivity profile stores Tailscale and messaging settings.'));
  console.log(chalk.dim('Use it to configure how workstations connect to your network.\n'));

  const name =
    providedName ||
    (await input({
      message: 'Profile name:',
      validate: (v) => {
        if (!v.trim()) return 'Name is required';
        if (!/^[a-zA-Z0-9-_]+$/.test(v))
          return 'Only alphanumeric, hyphens, and underscores allowed';
        return true;
      },
    }));

  // Check if profile already exists
  const existing = await getConnectivityProfile(name);
  if (existing) {
    console.log(
      chalk.yellow(
        `\nProfile '${name}' already exists. Use 'clawdult profiles connectivity edit ${name}' to modify it.\n`
      )
    );
    // Return the existing profile for use in create.ts flow
    return existing;
  }

  // Data collection loop (supports "start over")
  while (true) {
    const description = await input({
      message: 'Description (optional):',
    });

    // Tailscale
    let tailscaleKey: string | undefined;
    const wantsTailscale = await confirm({
      message: 'Configure Tailscale?',
      default: false,
    });

    // Smart default: enable gateway via Tailscale when available
    let gatewayMode: GatewayMode = 'local';

    if (wantsTailscale) {
      console.log(chalk.cyan('\n  To get a Tailscale auth key:\n'));
      console.log(
        chalk.dim('  1. Go to: ') + clickableUrl('https://login.tailscale.com/admin/settings/keys')
      );
      console.log(chalk.dim('  2. Click "Generate auth key"'));
      console.log(chalk.dim('  3. Recommended settings:'));
      console.log(
        chalk.dim('     • Description: something to identify this key (e.g., "clawdult")')
      );
      console.log(chalk.dim('     • Reusable: ON (allows multiple workstations)'));
      console.log(chalk.dim('     • Expiration: 90 days'));
      console.log(chalk.dim('     • Ephemeral: OFF (keeps workstations in network after reboot)'));
      console.log(chalk.dim('     • Tags: OFF (unless you have ACL policies)'));
      console.log(
        chalk.dim('  4. Click "Generate key" and copy it (starts with tskey-auth-...)\n')
      );

      const tsKey = await password({
        message: 'Tailscale auth key (tskey-auth-...):',
        mask: '*',
      });

      if (tsKey.trim()) {
        if (!tsKey.startsWith('tskey-auth-')) {
          console.log(
            chalk.yellow('Warning: Tailscale auth keys typically start with "tskey-auth-"')
          );
        }
        tailscaleKey = tsKey.trim();
      }

      // Gateway mode selection (only available with Tailscale)
      if (tailscaleKey) {
        console.log(chalk.cyan('\n  Gateway exposure mode:\n'));
        console.log(
          chalk.dim('  • tailscale-serve: Gateway accessible from your tailnet (recommended)')
        );
        console.log(chalk.dim('  • tailscale-funnel: Gateway accessible from public internet'));
        console.log(chalk.dim('  • local: Gateway only accessible via SSH tunnel'));
        console.log(chalk.dim('  • none: Disable gateway entirely\n'));

        gatewayMode = await select({
          message: 'Gateway mode:',
          choices: [
            {
              value: 'tailscale-serve' as const,
              name: 'Tailscale Serve (private tailnet) - recommended',
            },
            { value: 'tailscale-funnel' as const, name: 'Tailscale Funnel (public internet)' },
            { value: 'local' as const, name: 'Local (SSH tunnel required)' },
            { value: 'none' as const, name: 'Disabled' },
          ],
          default: 'tailscale-serve',
        });

        if (gatewayMode === 'tailscale-funnel') {
          console.log(
            chalk.yellow(
              '\n  ⚠️  Warning: Tailscale Funnel exposes the gateway to the public internet.'
            )
          );
          console.log(
            chalk.yellow('  Anyone with the URL and auth token can access the gateway.\n')
          );
          const confirmFunnel = await confirm({
            message: 'Are you sure you want to enable public access?',
            default: false,
          });
          if (!confirmFunnel) {
            gatewayMode = 'tailscale-serve';
            console.log(chalk.dim('  Switched to Tailscale Serve (private tailnet).\n'));
          }
        }
      }
    }

    // OpenClaw channels
    console.log(chalk.dim('\n  Use SPACE to select/deselect, ENTER to confirm.\n'));
    const channels = await checkbox({
      message: 'Select messaging channels to enable:',
      choices: [
        { value: 'whatsapp', name: 'WhatsApp' },
        { value: 'telegram', name: 'Telegram' },
        { value: 'slack', name: 'Slack' },
        { value: 'discord', name: 'Discord' },
        { value: 'signal', name: 'Signal' },
        { value: 'googlechat', name: 'Google Chat' },
        { value: 'teams', name: 'Microsoft Teams' },
        { value: 'matrix', name: 'Matrix' },
        { value: 'webchat', name: 'WebChat' },
        { value: 'bluebubbles', name: 'BlueBubbles' },
        { value: 'zalo', name: 'Zalo' },
      ],
    });

    // Collect tokens for channels that need them
    let discordToken: string | undefined;
    let slackToken: string | undefined;
    let telegramToken: string | undefined;
    let googlechatToken: string | undefined;
    let teamsToken: string | undefined;
    let matrixToken: string | undefined;
    let webchatToken: string | undefined;
    let blueBubblesToken: string | undefined;
    let zaloToken: string | undefined;

    if (channels.includes('discord')) {
      console.log(chalk.cyan('\n  To get a Discord bot token:\n'));
      console.log(
        chalk.dim('  1. Go to: ') + clickableUrl('https://discord.com/developers/applications')
      );
      console.log(chalk.dim('  2. Click "New Application" and give it a name'));
      console.log(chalk.dim('  3. Go to "Bot" in the left sidebar'));
      console.log(chalk.dim('  4. Click "Reset Token" and copy the token'));
      console.log(chalk.dim('  5. To invite to your server: OAuth2 → URL Generator'));
      console.log(chalk.dim('     • Check "bot" under Scopes'));
      console.log(chalk.dim('     • Select permissions:'));
      console.log(chalk.dim('       General: View Channels'));
      console.log(
        chalk.dim('       Text: Send Messages, Create Public Threads, Create Private Threads,')
      );
      console.log(chalk.dim('             Send Messages in Threads, Read Message History,'));
      console.log(chalk.dim('             Attach Files, Embed Links, Add Reactions'));
      console.log(
        chalk.dim('       Voice: Connect, Speak, Request To Speak, Set Voice Channel Status')
      );
      console.log(chalk.dim('     • Open the generated URL to invite\n'));

      const token = await password({
        message: 'Discord bot token:',
        mask: '*',
      });
      if (token.trim()) discordToken = token.trim();
    }

    if (channels.includes('slack')) {
      console.log(chalk.dim('\n  Get a Slack OAuth token from your Slack app settings.\n'));
      const token = await password({
        message: 'Slack OAuth token:',
        mask: '*',
      });
      if (token.trim()) slackToken = token.trim();
    }

    if (channels.includes('telegram')) {
      console.log(chalk.dim('\n  Get a Telegram bot token from @BotFather on Telegram.\n'));
      const token = await password({
        message: 'Telegram bot token:',
        mask: '*',
      });
      if (token.trim()) telegramToken = token.trim();
    }

    if (channels.includes('googlechat')) {
      console.log(chalk.cyan('\n  To get a Google Chat service account:\n'));
      console.log(
        chalk.dim('  1. Go to: ') +
          clickableUrl('https://console.cloud.google.com/apis/credentials')
      );
      console.log(chalk.dim('  2. Create a service account'));
      console.log(chalk.dim('  3. Enable the Google Chat API'));
      console.log(chalk.dim('  4. Download the service account JSON key\n'));

      const token = await password({
        message: 'Google Chat service account JSON (paste as single line):',
        mask: '*',
      });
      if (token.trim()) googlechatToken = token.trim();
    }

    if (channels.includes('teams')) {
      console.log(chalk.cyan('\n  To get a Microsoft Teams app secret:\n'));
      console.log(
        chalk.dim('  1. Go to: ') +
          clickableUrl(
            'https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'
          )
      );
      console.log(chalk.dim('  2. Register a new application'));
      console.log(chalk.dim('  3. Create a client secret under Certificates & secrets'));
      console.log(chalk.dim('  4. Copy the secret value\n'));

      const token = await password({
        message: 'Microsoft Teams app secret:',
        mask: '*',
      });
      if (token.trim()) teamsToken = token.trim();
    }

    if (channels.includes('matrix')) {
      console.log(chalk.cyan('\n  To get a Matrix access token:\n'));
      console.log(chalk.dim('  1. Log in to your Matrix homeserver'));
      console.log(chalk.dim('  2. Go to Settings → Help & About → Access Token'));
      console.log(chalk.dim('  3. Copy the access token\n'));

      const token = await password({
        message: 'Matrix homeserver access token:',
        mask: '*',
      });
      if (token.trim()) matrixToken = token.trim();
    }

    if (channels.includes('webchat')) {
      console.log(chalk.cyan('\n  WebChat uses a built-in authentication token.\n'));
      console.log(chalk.dim('  Enter a secure token for WebChat authentication.\n'));

      const token = await password({
        message: 'WebChat auth token:',
        mask: '*',
      });
      if (token.trim()) webchatToken = token.trim();
    }

    if (channels.includes('bluebubbles')) {
      console.log(chalk.cyan('\n  To get a BlueBubbles server password:\n'));
      console.log(chalk.dim('  1. Open BlueBubbles Server on your Mac'));
      console.log(chalk.dim('  2. Go to Settings → Server'));
      console.log(chalk.dim('  3. Copy the server password\n'));

      const token = await password({
        message: 'BlueBubbles server password:',
        mask: '*',
      });
      if (token.trim()) blueBubblesToken = token.trim();
    }

    if (channels.includes('zalo')) {
      console.log(chalk.cyan('\n  To get a Zalo OA access token:\n'));
      console.log(chalk.dim('  1. Go to: ') + clickableUrl('https://developers.zalo.me/'));
      console.log(chalk.dim('  2. Create or select your Official Account'));
      console.log(chalk.dim('  3. Generate an OA access token\n'));

      const token = await password({
        message: 'Zalo OA access token:',
        mask: '*',
      });
      if (token.trim()) zaloToken = token.trim();
    }

    // Per-channel DM policies
    const dmPolicies: Record<string, DmPolicy> = {};
    if (channels.length > 0) {
      const configurePolicies = await confirm({
        message: 'Configure per-channel DM policies? (default: allow all)',
        default: false,
      });

      if (configurePolicies) {
        for (const channel of channels) {
          const policy = await select<DmPolicy>({
            message: `DM policy for ${channel}:`,
            choices: [
              { value: 'allow', name: 'Allow - agent can send and receive DMs' },
              {
                value: 'receive-only',
                name: 'Receive only - agent can receive but not initiate DMs',
              },
              { value: 'deny', name: 'Deny - no DMs on this channel' },
            ],
            default: 'allow',
          });
          dmPolicies[channel] = policy;
        }
      }
    }

    // OpenClaw model selection (always shown — needed for daemon pre-config)
    let openclawModel: string | undefined;
    const modelChoices = await getModelChoices();
    const modelSelection = await select({
      message: 'OpenClaw model:',
      choices: modelChoices,
      default: DEFAULT_OPENCLAW_MODEL,
    });

    if (isCustomSentinel(modelSelection)) {
      openclawModel = await input({
        message: 'Custom model (provider/model):',
        validate: (v) =>
          MODEL_ID_PATTERN.test(v.trim()) ||
          'Must be provider/model format (e.g. anthropic/claude-opus-4-6)',
      });
    } else if (isDefaultSentinel(modelSelection)) {
      openclawModel = undefined;
    } else {
      openclawModel = modelSelection;
    }

    // Automation settings
    console.log(
      chalk.dim('\n  Automation allows agents to run scheduled tasks and respond to webhooks.\n')
    );
    const automationCronEnabled = await confirm({
      message: 'Enable cron jobs (scheduled tasks)?',
      default: false,
    });

    let automationCronMaxConcurrent = 5;
    if (automationCronEnabled) {
      const maxConcurrentStr = await input({
        message: 'Max concurrent cron jobs (1-20):',
        default: '5',
        validate: (v) => {
          if (!/^\d+$/.test(v)) return 'Must be a valid integer';
          const num = parseInt(v, 10);
          if (num < 1 || num > 20) return 'Must be between 1 and 20';
          return true;
        },
      });
      automationCronMaxConcurrent = parseInt(maxConcurrentStr, 10);
    }

    const automationWebhooksEnabled = await confirm({
      message: 'Enable webhooks (HTTP triggers)?',
      default: false,
    });

    let automationWebhooksPort = 18790;
    if (automationWebhooksEnabled) {
      const portStr = await input({
        message: 'Webhook port (1024-65535):',
        default: '18790',
        validate: (v) => {
          if (!/^\d+$/.test(v)) return 'Must be a valid integer';
          const num = parseInt(v, 10);
          if (num < 1024 || num > 65535) return 'Must be a port between 1024 and 65535';
          return true;
        },
      });
      automationWebhooksPort = parseInt(portStr, 10);
    }

    // Show summary and confirm
    const parts: string[] = [];
    if (tailscaleKey) parts.push('Tailscale');
    if (channels.length > 0) parts.push(`Channels: ${channels.join(', ')}`);
    if (automationCronEnabled) parts.push('Cron');
    if (automationWebhooksEnabled) parts.push(`Webhooks:${automationWebhooksPort}`);

    console.log(chalk.dim('\nProfile summary:'));
    console.log(chalk.dim(`  Name:     ${name}`));
    if (description) console.log(chalk.dim(`  Desc:     ${description}`));
    console.log(chalk.dim(`  Features: ${parts.length > 0 ? parts.join(', ') : 'none'}`));
    if (tailscaleKey) console.log(chalk.dim(`  Gateway:  ${gatewayMode}`));
    console.log();

    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { value: 'save', name: 'Save profile' },
        { value: 'restart', name: 'Start over' },
        { value: 'cancel', name: 'Cancel' },
      ],
    });

    if (action === 'cancel') {
      console.log(chalk.yellow('\nCancelled.\n'));
      return null;
    }

    if (action === 'restart') {
      console.log(chalk.dim('\nStarting over...\n'));
      continue;
    }

    const profile = await createConnectivityProfile(
      name,
      {
        tailscaleKey,
        gatewayMode,
        openclawModel: openclawModel || undefined,
        openclawChannels: channels,
        discordToken,
        slackToken,
        telegramToken,
        googlechatToken,
        teamsToken,
        matrixToken,
        webchatToken,
        blueBubblesToken,
        zaloToken,
        dmPolicies,
        automationCronEnabled,
        automationCronMaxConcurrent,
        automationWebhooksEnabled,
        automationWebhooksPort,
      },
      description || undefined
    );

    console.log(chalk.green('✓') + ` Created connectivity profile: ${profile.name}\n`);
    return profile;
  }
}

async function editProfileInteractive(
  existingProfile: ConnectivityProfile
): Promise<ConnectivityProfile> {
  console.log(chalk.cyan(`\nEditing profile: ${existingProfile.name}\n`));

  // Tailscale
  let tailscaleKey: string | undefined;
  const currentTailscale = existingProfile.hasTailscaleKey ? 'configured' : 'not configured';
  const editTailscale = await confirm({
    message: `Tailscale is ${currentTailscale}. Update Tailscale key?`,
    default: false,
  });

  if (editTailscale) {
    console.log(chalk.cyan('\n  To get a Tailscale auth key:\n'));
    console.log(
      chalk.dim('  1. Go to: ') + clickableUrl('https://login.tailscale.com/admin/settings/keys')
    );
    console.log(chalk.dim('  2. Click "Generate auth key"'));
    console.log(chalk.dim('  3. Recommended settings:'));
    console.log(chalk.dim('     • Description: something to identify this key (e.g., "clawdult")'));
    console.log(chalk.dim('     • Reusable: ON (allows multiple workstations)'));
    console.log(chalk.dim('     • Expiration: 90 days'));
    console.log(chalk.dim('     • Ephemeral: OFF (keeps workstations in network after reboot)'));
    console.log(chalk.dim('     • Tags: OFF (unless you have ACL policies)'));
    console.log(chalk.dim('  4. Click "Generate key" and copy it (starts with tskey-auth-...)\n'));

    const tsKey = await password({
      message: 'Tailscale auth key (tskey-auth-...):',
      mask: '*',
    });

    if (tsKey.trim()) {
      if (!tsKey.startsWith('tskey-auth-')) {
        console.log(
          chalk.yellow('Warning: Tailscale auth keys typically start with "tskey-auth-"')
        );
      }
      tailscaleKey = tsKey.trim();
    }
  }

  // Gateway mode
  let gatewayMode = existingProfile.gatewayMode || 'local';
  const hasTailscale = tailscaleKey || existingProfile.hasTailscaleKey;
  if (hasTailscale) {
    const currentGatewayMode = existingProfile.gatewayMode || 'local';
    const editGateway = await confirm({
      message: `Gateway mode is '${currentGatewayMode}'. Update gateway mode?`,
      default: false,
    });

    if (editGateway) {
      console.log(chalk.cyan('\n  Gateway exposure mode:\n'));
      console.log(
        chalk.dim('  • tailscale-serve: Gateway accessible from your tailnet (recommended)')
      );
      console.log(chalk.dim('  • tailscale-funnel: Gateway accessible from public internet'));
      console.log(chalk.dim('  • local: Gateway only accessible via SSH tunnel'));
      console.log(chalk.dim('  • none: Disable gateway entirely\n'));

      gatewayMode = await select({
        message: 'Gateway mode:',
        choices: [
          {
            value: 'tailscale-serve' as const,
            name: 'Tailscale Serve (private tailnet) - recommended',
          },
          { value: 'tailscale-funnel' as const, name: 'Tailscale Funnel (public internet)' },
          { value: 'local' as const, name: 'Local (SSH tunnel required)' },
          { value: 'none' as const, name: 'Disabled' },
        ],
        default: currentGatewayMode,
      });

      if (gatewayMode === 'tailscale-funnel') {
        console.log(
          chalk.yellow(
            '\n  ⚠️  Warning: Tailscale Funnel exposes the gateway to the public internet.'
          )
        );
        console.log(chalk.yellow('  Anyone with the URL and auth token can access the gateway.\n'));
        const confirmFunnel = await confirm({
          message: 'Are you sure you want to enable public access?',
          default: false,
        });
        if (!confirmFunnel) {
          gatewayMode = 'tailscale-serve';
          console.log(chalk.dim('  Switched to Tailscale Serve (private tailnet).\n'));
        }
      }
    }
  }

  // Messaging channels
  const currentChannels =
    existingProfile.openclawChannels.length > 0
      ? existingProfile.openclawChannels.join(', ')
      : 'none';
  const editChannels = await confirm({
    message: `Messaging channels: ${currentChannels}. Update channels?`,
    default: false,
  });

  let channels = existingProfile.openclawChannels;
  let discordToken: string | undefined;
  let slackToken: string | undefined;
  let telegramToken: string | undefined;
  let googlechatToken: string | undefined;
  let teamsToken: string | undefined;
  let matrixToken: string | undefined;
  let webchatToken: string | undefined;
  let blueBubblesToken: string | undefined;
  let zaloToken: string | undefined;

  if (editChannels) {
    console.log(chalk.dim('\n  Use SPACE to select/deselect, ENTER to confirm.\n'));
    channels = await checkbox({
      message: 'Select messaging channels to enable:',
      choices: [
        {
          value: 'whatsapp',
          name: 'WhatsApp',
          checked: existingProfile.openclawChannels.includes('whatsapp'),
        },
        {
          value: 'telegram',
          name: 'Telegram',
          checked: existingProfile.openclawChannels.includes('telegram'),
        },
        {
          value: 'slack',
          name: 'Slack',
          checked: existingProfile.openclawChannels.includes('slack'),
        },
        {
          value: 'discord',
          name: 'Discord',
          checked: existingProfile.openclawChannels.includes('discord'),
        },
        {
          value: 'signal',
          name: 'Signal',
          checked: existingProfile.openclawChannels.includes('signal'),
        },
        {
          value: 'googlechat',
          name: 'Google Chat',
          checked: existingProfile.openclawChannels.includes('googlechat'),
        },
        {
          value: 'teams',
          name: 'Microsoft Teams',
          checked: existingProfile.openclawChannels.includes('teams'),
        },
        {
          value: 'matrix',
          name: 'Matrix',
          checked: existingProfile.openclawChannels.includes('matrix'),
        },
        {
          value: 'webchat',
          name: 'WebChat',
          checked: existingProfile.openclawChannels.includes('webchat'),
        },
        {
          value: 'bluebubbles',
          name: 'BlueBubbles',
          checked: existingProfile.openclawChannels.includes('bluebubbles'),
        },
        {
          value: 'zalo',
          name: 'Zalo',
          checked: existingProfile.openclawChannels.includes('zalo'),
        },
      ],
    });

    // Ask for tokens for newly added channels
    const newDiscord =
      channels.includes('discord') && !existingProfile.openclawChannels.includes('discord');
    const newSlack =
      channels.includes('slack') && !existingProfile.openclawChannels.includes('slack');
    const newTelegram =
      channels.includes('telegram') && !existingProfile.openclawChannels.includes('telegram');
    const newGooglechat =
      channels.includes('googlechat') && !existingProfile.openclawChannels.includes('googlechat');
    const newTeams =
      channels.includes('teams') && !existingProfile.openclawChannels.includes('teams');
    const newMatrix =
      channels.includes('matrix') && !existingProfile.openclawChannels.includes('matrix');
    const newWebchat =
      channels.includes('webchat') && !existingProfile.openclawChannels.includes('webchat');
    const newBluebubbles =
      channels.includes('bluebubbles') && !existingProfile.openclawChannels.includes('bluebubbles');
    const newZalo = channels.includes('zalo') && !existingProfile.openclawChannels.includes('zalo');

    if (newDiscord || (channels.includes('discord') && !existingProfile.hasDiscordToken)) {
      console.log(chalk.cyan('\n  To get a Discord bot token:\n'));
      console.log(
        chalk.dim('  1. Go to: ') + clickableUrl('https://discord.com/developers/applications')
      );
      console.log(chalk.dim('  2. Click "New Application" and give it a name'));
      console.log(chalk.dim('  3. Go to "Bot" in the left sidebar'));
      console.log(chalk.dim('  4. Click "Reset Token" and copy the token'));
      console.log(chalk.dim('  5. To invite to your server: OAuth2 → URL Generator'));
      console.log(chalk.dim('     • Check "bot" under Scopes'));
      console.log(chalk.dim('     • Select permissions:'));
      console.log(chalk.dim('       General: View Channels'));
      console.log(
        chalk.dim('       Text: Send Messages, Create Public Threads, Create Private Threads,')
      );
      console.log(chalk.dim('             Send Messages in Threads, Read Message History,'));
      console.log(chalk.dim('             Attach Files, Embed Links, Add Reactions'));
      console.log(
        chalk.dim('       Voice: Connect, Speak, Request To Speak, Set Voice Channel Status')
      );
      console.log(chalk.dim('     • Open the generated URL to invite\n'));

      const token = await password({
        message: 'Discord bot token:',
        mask: '*',
      });
      if (token.trim()) discordToken = token.trim();
    }

    if (newSlack || (channels.includes('slack') && !existingProfile.hasSlackToken)) {
      console.log(chalk.dim('\n  Get a Slack OAuth token from your Slack app settings.\n'));
      const token = await password({
        message: 'Slack OAuth token:',
        mask: '*',
      });
      if (token.trim()) slackToken = token.trim();
    }

    if (newTelegram || (channels.includes('telegram') && !existingProfile.hasTelegramToken)) {
      console.log(chalk.dim('\n  Get a Telegram bot token from @BotFather on Telegram.\n'));
      const token = await password({
        message: 'Telegram bot token:',
        mask: '*',
      });
      if (token.trim()) telegramToken = token.trim();
    }

    if (newGooglechat || (channels.includes('googlechat') && !existingProfile.hasGooglechatToken)) {
      console.log(chalk.cyan('\n  To get a Google Chat service account:\n'));
      console.log(
        chalk.dim('  1. Go to: ') +
          clickableUrl('https://console.cloud.google.com/apis/credentials')
      );
      console.log(chalk.dim('  2. Create a service account'));
      console.log(chalk.dim('  3. Enable the Google Chat API'));
      console.log(chalk.dim('  4. Download the service account JSON key\n'));

      const token = await password({
        message: 'Google Chat service account JSON (paste as single line):',
        mask: '*',
      });
      if (token.trim()) googlechatToken = token.trim();
    }

    if (newTeams || (channels.includes('teams') && !existingProfile.hasTeamsToken)) {
      console.log(chalk.cyan('\n  To get a Microsoft Teams app secret:\n'));
      console.log(
        chalk.dim('  1. Go to: ') +
          clickableUrl(
            'https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'
          )
      );
      console.log(chalk.dim('  2. Register a new application'));
      console.log(chalk.dim('  3. Create a client secret under Certificates & secrets'));
      console.log(chalk.dim('  4. Copy the secret value\n'));

      const token = await password({
        message: 'Microsoft Teams app secret:',
        mask: '*',
      });
      if (token.trim()) teamsToken = token.trim();
    }

    if (newMatrix || (channels.includes('matrix') && !existingProfile.hasMatrixToken)) {
      console.log(chalk.cyan('\n  To get a Matrix access token:\n'));
      console.log(chalk.dim('  1. Log in to your Matrix homeserver'));
      console.log(chalk.dim('  2. Go to Settings → Help & About → Access Token'));
      console.log(chalk.dim('  3. Copy the access token\n'));

      const token = await password({
        message: 'Matrix homeserver access token:',
        mask: '*',
      });
      if (token.trim()) matrixToken = token.trim();
    }

    if (newWebchat || (channels.includes('webchat') && !existingProfile.hasWebchatToken)) {
      console.log(chalk.cyan('\n  WebChat uses a built-in authentication token.\n'));
      console.log(chalk.dim('  Enter a secure token for WebChat authentication.\n'));

      const token = await password({
        message: 'WebChat auth token:',
        mask: '*',
      });
      if (token.trim()) webchatToken = token.trim();
    }

    if (
      newBluebubbles ||
      (channels.includes('bluebubbles') && !existingProfile.hasBlueBubblesToken)
    ) {
      console.log(chalk.cyan('\n  To get a BlueBubbles server password:\n'));
      console.log(chalk.dim('  1. Open BlueBubbles Server on your Mac'));
      console.log(chalk.dim('  2. Go to Settings → Server'));
      console.log(chalk.dim('  3. Copy the server password\n'));

      const token = await password({
        message: 'BlueBubbles server password:',
        mask: '*',
      });
      if (token.trim()) blueBubblesToken = token.trim();
    }

    if (newZalo || (channels.includes('zalo') && !existingProfile.hasZaloToken)) {
      console.log(chalk.cyan('\n  To get a Zalo OA access token:\n'));
      console.log(chalk.dim('  1. Go to: ') + clickableUrl('https://developers.zalo.me/'));
      console.log(chalk.dim('  2. Create or select your Official Account'));
      console.log(chalk.dim('  3. Generate an OA access token\n'));

      const token = await password({
        message: 'Zalo OA access token:',
        mask: '*',
      });
      if (token.trim()) zaloToken = token.trim();
    }
  }

  // Per-channel DM policies
  let dmPolicies: Record<string, DmPolicy> = { ...(existingProfile.dmPolicies || {}) };
  if (channels.length > 0) {
    const currentPolicies =
      Object.keys(dmPolicies).length > 0
        ? Object.entries(dmPolicies)
            .map(([ch, p]) => `${ch}:${p}`)
            .join(', ')
        : 'all allow';
    const editPolicies = await confirm({
      message: `DM policies: ${currentPolicies}. Update DM policies?`,
      default: false,
    });

    if (editPolicies) {
      dmPolicies = {};
      for (const channel of channels) {
        const currentPolicy = existingProfile.dmPolicies?.[channel] || 'allow';
        const policy = await select<DmPolicy>({
          message: `DM policy for ${channel}:`,
          choices: [
            { value: 'allow', name: 'Allow - agent can send and receive DMs' },
            {
              value: 'receive-only',
              name: 'Receive only - agent can receive but not initiate DMs',
            },
            { value: 'deny', name: 'Deny - no DMs on this channel' },
          ],
          default: currentPolicy,
        });
        dmPolicies[channel] = policy;
      }
    }
  }

  // OpenClaw model
  let openclawModel = existingProfile.openclawModel;
  const currentModel =
    existingProfile.openclawModel || `system default (${DEFAULT_OPENCLAW_MODEL})`;
  const editModel = await confirm({
    message: `OpenClaw model: ${currentModel}. Update model?`,
    default: false,
  });

  if (editModel) {
    const modelChoices = await getModelChoices();
    const modelSelection = await select({
      message: 'OpenClaw model:',
      choices: modelChoices,
      default: existingProfile.openclawModel || DEFAULT_OPENCLAW_MODEL,
    });

    if (isCustomSentinel(modelSelection)) {
      openclawModel = await input({
        message: 'Custom model (provider/model):',
        validate: (v) =>
          MODEL_ID_PATTERN.test(v.trim()) ||
          'Must be provider/model format (e.g. anthropic/claude-opus-4-6)',
      });
    } else if (isDefaultSentinel(modelSelection)) {
      openclawModel = undefined;
    } else {
      openclawModel = modelSelection;
    }
  }

  // Automation settings
  const currentCron = existingProfile.automationCronEnabled ? 'enabled' : 'disabled';
  const editCron = await confirm({
    message: `Cron jobs: ${currentCron}. Update cron settings?`,
    default: false,
  });

  let automationCronEnabled = existingProfile.automationCronEnabled;
  let automationCronMaxConcurrent = existingProfile.automationCronMaxConcurrent;

  if (editCron) {
    automationCronEnabled = await confirm({
      message: 'Enable cron jobs (scheduled tasks)?',
      default: existingProfile.automationCronEnabled,
    });

    if (automationCronEnabled) {
      const maxConcurrentStr = await input({
        message: 'Max concurrent cron jobs (1-20):',
        default: String(existingProfile.automationCronMaxConcurrent),
        validate: (v) => {
          if (!/^\d+$/.test(v)) return 'Must be a valid integer';
          const num = parseInt(v, 10);
          if (num < 1 || num > 20) return 'Must be between 1 and 20';
          return true;
        },
      });
      automationCronMaxConcurrent = parseInt(maxConcurrentStr, 10);
    }
  }

  const currentWebhooks = existingProfile.automationWebhooksEnabled ? 'enabled' : 'disabled';
  const editWebhooks = await confirm({
    message: `Webhooks: ${currentWebhooks}. Update webhook settings?`,
    default: false,
  });

  let automationWebhooksEnabled = existingProfile.automationWebhooksEnabled;
  let automationWebhooksPort = existingProfile.automationWebhooksPort;

  if (editWebhooks) {
    automationWebhooksEnabled = await confirm({
      message: 'Enable webhooks (HTTP triggers)?',
      default: existingProfile.automationWebhooksEnabled,
    });

    if (automationWebhooksEnabled) {
      const portStr = await input({
        message: 'Webhook port (1024-65535):',
        default: String(existingProfile.automationWebhooksPort),
        validate: (v) => {
          if (!/^\d+$/.test(v)) return 'Must be a valid integer';
          const num = parseInt(v, 10);
          if (num < 1024 || num > 65535) return 'Must be a port between 1024 and 65535';
          return true;
        },
      });
      automationWebhooksPort = parseInt(portStr, 10);
    }
  }

  // Update the profile
  const updatedProfile: ConnectivityProfile = {
    ...existingProfile,
    openclawModel,
    openclawChannels: channels,
    hasTailscaleKey: tailscaleKey ? true : existingProfile.hasTailscaleKey,
    gatewayMode,
    hasDiscordToken: discordToken ? true : existingProfile.hasDiscordToken,
    hasSlackToken: slackToken ? true : existingProfile.hasSlackToken,
    hasTelegramToken: telegramToken ? true : existingProfile.hasTelegramToken,
    hasGooglechatToken: googlechatToken ? true : existingProfile.hasGooglechatToken,
    hasTeamsToken: teamsToken ? true : existingProfile.hasTeamsToken,
    hasMatrixToken: matrixToken ? true : existingProfile.hasMatrixToken,
    hasWebchatToken: webchatToken ? true : existingProfile.hasWebchatToken,
    hasBlueBubblesToken: blueBubblesToken ? true : existingProfile.hasBlueBubblesToken,
    hasZaloToken: zaloToken ? true : existingProfile.hasZaloToken,
    dmPolicies,
    automationCronEnabled,
    automationCronMaxConcurrent,
    automationWebhooksEnabled,
    automationWebhooksPort,
  };

  await saveConnectivityProfile(updatedProfile);

  // Store new secrets
  if (tailscaleKey) await setProfileSecret(existingProfile.name, 'tailscale', tailscaleKey);
  if (discordToken) await setProfileSecret(existingProfile.name, 'discord', discordToken);
  if (slackToken) await setProfileSecret(existingProfile.name, 'slack', slackToken);
  if (telegramToken) await setProfileSecret(existingProfile.name, 'telegram', telegramToken);
  if (googlechatToken) await setProfileSecret(existingProfile.name, 'googlechat', googlechatToken);
  if (teamsToken) await setProfileSecret(existingProfile.name, 'teams', teamsToken);
  if (matrixToken) await setProfileSecret(existingProfile.name, 'matrix', matrixToken);
  if (webchatToken) await setProfileSecret(existingProfile.name, 'webchat', webchatToken);
  if (blueBubblesToken)
    await setProfileSecret(existingProfile.name, 'bluebubbles', blueBubblesToken);
  if (zaloToken) await setProfileSecret(existingProfile.name, 'zalo', zaloToken);

  console.log(
    chalk.green('✓') +
      ` Updated connectivity profile: ${updatedProfile.name} (${getConfiguredDescription(updatedProfile)})\n`
  );
  return updatedProfile;
}

// Export the interactive functions for use in create command
export { createProfileInteractive, editProfileInteractive };
