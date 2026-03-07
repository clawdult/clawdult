import crypto from 'node:crypto';
import {
  SSMClient,
  PutParameterCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  ParameterAlreadyExists,
  ParameterNotFound,
} from '@aws-sdk/client-ssm';
import { getSecret } from './secrets.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GitHubAgentAccount, AgentInstructions } from '../schemas/config.js';
import { getAgentToken } from './github-agent.js';
import { getAWSClientConfig } from './aws-client.js';
import { retryWithBackoff } from './aws-retry.js';
import { getProfileWithKeys, KEY_NAME_MAP as PROFILE_KEY_MAP } from './key-profiles.js';
import { getProfileWithSecrets as getConnectivityProfileWithSecrets } from './connectivity-profiles.js';

const SSM_TRANSIENT_ERRORS = ['ThrottlingException', 'InternalServerError', 'ServiceUnavailable'];

async function createSSMClient(region: string): Promise<SSMClient> {
  return new SSMClient(await getAWSClientConfig(region));
}

interface PutParameterOptions {
  name: string;
  value: string;
  type: 'String' | 'SecureString';
  agentName: string;
}

/**
 * Put a parameter to SSM, handling the AWS limitation that tags and overwrite
 * can't be used together. First tries to create with tags, then falls back to
 * overwrite without tags if the parameter already exists.
 */
async function putParameter(
  client: SSMClient,
  { name, value, type, agentName }: PutParameterOptions
): Promise<void> {
  const tags = [
    { Key: 'clawdult:agent', Value: agentName },
    { Key: 'clawdult:managed', Value: 'true' },
  ];

  await retryWithBackoff(
    async () => {
      try {
        await client.send(
          new PutParameterCommand({ Name: name, Value: value, Type: type, Tags: tags })
        );
      } catch (error) {
        if (error instanceof ParameterAlreadyExists) {
          await client.send(
            new PutParameterCommand({ Name: name, Value: value, Type: type, Overwrite: true })
          );
        } else {
          throw error;
        }
      }
    },
    { transientErrors: SSM_TRANSIENT_ERRORS }
  );
}

/**
 * Get the Tailscale IP for an agent from SSM.
 * Returns null if not found (agent doesn't have Tailscale or IP not yet stored).
 */
export async function getTailscaleIP(agentName: string, region: string): Promise<string | null> {
  const client = await createSSMClient(region);

  try {
    const response = await retryWithBackoff(
      () =>
        client.send(
          new GetParameterCommand({
            Name: `/clawdult/${agentName}/tailscale-ip`,
          })
        ),
      { transientErrors: SSM_TRANSIENT_ERRORS }
    );
    return response.Parameter?.Value ?? null;
  } catch (error) {
    if (error instanceof ParameterNotFound) {
      return null;
    }
    throw error;
  }
}

// Key name translation: wizard names -> SSM/wrapper names
const KEY_NAME_MAP: Record<string, string> = {
  claude: 'anthropic-api-key',
  openai: 'openai-api-key',
  grok: 'xai-api-key',
  gemini: 'google-api-key',
};

export interface PushSecretsResult {
  pushed: string[];
  skipped: string[];
}

export async function pushSecretsToSSM(
  agentName: string,
  region: string
): Promise<PushSecretsResult> {
  const client = await createSSMClient(region);
  const pushed: string[] = [];
  const skipped: string[] = [];

  const failed: Array<{ type: string; error: string }> = [];

  for (const [wizardKey, ssmKey] of Object.entries(KEY_NAME_MAP)) {
    const value = await getSecret('ai', wizardKey);
    if (!value) {
      skipped.push(wizardKey);
      continue;
    }

    try {
      await putParameter(client, {
        name: `/clawdult/${agentName}/${ssmKey}`,
        value,
        type: 'SecureString',
        agentName,
      });
      pushed.push(wizardKey);
    } catch (error) {
      failed.push({
        type: wizardKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failed.length > 0) {
    const failedList = failed.map((f) => `${f.type}: ${f.error}`).join(', ');
    const succeededList = pushed.length > 0 ? pushed.join(', ') : 'none';
    throw new Error(
      `Partial SSM push failure. Succeeded: [${succeededList}]. Failed: [${failedList}]`
    );
  }

  return { pushed, skipped };
}

export async function pushKeyProfileToSSM(
  agentName: string,
  region: string,
  keyProfileName: string
): Promise<PushSecretsResult> {
  const client = await createSSMClient(region);
  const pushed: string[] = [];
  const skipped: string[] = [];

  const profile = await getProfileWithKeys(keyProfileName);
  if (!profile) {
    throw new Error(`Key profile '${keyProfileName}' not found`);
  }

  const keyMappings: Array<{ type: string; value: string | undefined; ssmKey: string }> = [
    { type: 'claude', value: profile.claudeKey, ssmKey: PROFILE_KEY_MAP.claude },
    {
      type: 'claude-setup-token',
      value: profile.claudeSetupToken,
      ssmKey: PROFILE_KEY_MAP['claude-setup-token'],
    },
    { type: 'openai', value: profile.openaiKey, ssmKey: PROFILE_KEY_MAP.openai },
    { type: 'grok', value: profile.grokKey, ssmKey: PROFILE_KEY_MAP.grok },
    { type: 'gemini', value: profile.geminiKey, ssmKey: PROFILE_KEY_MAP.gemini },
  ];

  const failed: Array<{ type: string; error: string }> = [];

  for (const { type, value, ssmKey } of keyMappings) {
    if (!value) {
      skipped.push(type);
      continue;
    }

    try {
      await putParameter(client, {
        name: `/clawdult/${agentName}/${ssmKey}`,
        value,
        type: 'SecureString',
        agentName,
      });
      pushed.push(type);
    } catch (error) {
      failed.push({ type, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (failed.length > 0) {
    const failedList = failed.map((f) => `${f.type}: ${f.error}`).join(', ');
    const succeededList = pushed.length > 0 ? pushed.join(', ') : 'none';
    throw new Error(
      `Partial SSM push failure. Succeeded: [${succeededList}]. Failed: [${failedList}]`
    );
  }

  return { pushed, skipped };
}

export async function pushGitHubCredentialsToSSM(
  agentName: string,
  region: string,
  account: GitHubAgentAccount
): Promise<void> {
  const client = await createSSMClient(region);
  const token = await getAgentToken(account.username);

  if (!token) {
    throw new Error(`No stored token found for GitHub account: ${account.username}`);
  }

  // Push token as SecureString
  await putParameter(client, {
    name: `/clawdult/${agentName}/github-token`,
    value: token,
    type: 'SecureString',
    agentName,
  });

  // Push git config as String
  await putParameter(client, {
    name: `/clawdult/${agentName}/github-username`,
    value: account.username,
    type: 'String',
    agentName,
  });

  await putParameter(client, {
    name: `/clawdult/${agentName}/github-email`,
    value: account.email,
    type: 'String',
    agentName,
  });
}

export async function pushTailscaleAuthKeyToSSM(
  agentName: string,
  region: string,
  authKey: string
): Promise<void> {
  const client = await createSSMClient(region);

  await putParameter(client, {
    name: `/clawdult/${agentName}/tailscale-auth-key`,
    value: authKey,
    type: 'SecureString',
    agentName,
  });
}

export interface OpenClawConfig {
  model?: string;
  channels: {
    whatsapp?: boolean;
    telegram?: boolean;
    slack?: boolean;
    discord?: boolean;
    signal?: boolean;
    googlechat?: boolean;
    teams?: boolean;
    matrix?: boolean;
    webchat?: boolean;
    bluebubbles?: boolean;
    zalo?: boolean;
  };
  dmPolicies?: Record<string, string>;
  security?: {
    dmPairing?: boolean;
    groupSandbox?: boolean;
  };
  automation?: {
    cron?: { enabled: boolean; maxConcurrent?: number };
    webhooks?: { enabled: boolean; port?: number };
  };
  gateway?: {
    mode: 'local' | 'tailscale-serve' | 'tailscale-funnel' | 'none';
  };
}

export async function pushOpenClawConfigToSSM(
  agentName: string,
  region: string,
  config: OpenClawConfig
): Promise<void> {
  const client = await createSSMClient(region);

  await putParameter(client, {
    name: `/clawdult/${agentName}/openclaw-config`,
    value: JSON.stringify(config),
    type: 'SecureString',
    agentName,
  });
}

export async function pushOpenClawTokenToSSM(agentName: string, region: string): Promise<string> {
  const client = await createSSMClient(region);
  const token = crypto.randomBytes(32).toString('hex');

  await putParameter(client, {
    name: `/clawdult/${agentName}/openclaw-token`,
    value: token,
    type: 'SecureString',
    agentName,
  });

  return token;
}

export async function getOpenClawToken(agentName: string, region: string): Promise<string | null> {
  const client = await createSSMClient(region);

  try {
    const response = await retryWithBackoff(
      () =>
        client.send(
          new GetParameterCommand({
            Name: `/clawdult/${agentName}/openclaw-token`,
            WithDecryption: true,
          })
        ),
      { transientErrors: SSM_TRANSIENT_ERRORS }
    );
    return response.Parameter?.Value ?? null;
  } catch (error) {
    if (error instanceof ParameterNotFound) {
      return null;
    }
    throw error;
  }
}

export interface MessagingCredentials {
  telegramBotToken?: string;
  slackOAuth?: string;
  discordOAuth?: string;
  googlechatToken?: string;
  teamsToken?: string;
  matrixToken?: string;
  webchatToken?: string;
  blueBubblesToken?: string;
  zaloToken?: string;
}

export async function pushMessagingCredentialsToSSM(
  agentName: string,
  region: string,
  credentials: MessagingCredentials
): Promise<PushSecretsResult> {
  const client = await createSSMClient(region);
  const pushed: string[] = [];
  const skipped: string[] = [];

  const credentialMappings: Array<{ key: keyof MessagingCredentials; ssmKey: string }> = [
    { key: 'telegramBotToken', ssmKey: 'telegram-bot-token' },
    { key: 'slackOAuth', ssmKey: 'slack-oauth' },
    { key: 'discordOAuth', ssmKey: 'discord-oauth' },
    { key: 'googlechatToken', ssmKey: 'googlechat-token' },
    { key: 'teamsToken', ssmKey: 'teams-token' },
    { key: 'matrixToken', ssmKey: 'matrix-token' },
    { key: 'webchatToken', ssmKey: 'webchat-token' },
    { key: 'blueBubblesToken', ssmKey: 'bluebubbles-token' },
    { key: 'zaloToken', ssmKey: 'zalo-token' },
  ];

  const failed: Array<{ type: string; error: string }> = [];

  for (const { key, ssmKey } of credentialMappings) {
    const value = credentials[key];
    if (!value) {
      skipped.push(key);
      continue;
    }

    try {
      await putParameter(client, {
        name: `/clawdult/${agentName}/${ssmKey}`,
        value,
        type: 'SecureString',
        agentName,
      });
      pushed.push(key);
    } catch (error) {
      failed.push({ type: key, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (failed.length > 0) {
    const failedList = failed.map((f) => `${f.type}: ${f.error}`).join(', ');
    const succeededList = pushed.length > 0 ? pushed.join(', ') : 'none';
    throw new Error(
      `Partial SSM push failure. Succeeded: [${succeededList}]. Failed: [${failedList}]`
    );
  }

  return { pushed, skipped };
}

export interface PushConnectivityProfileResult {
  tailscale: boolean;
  openclaw: boolean;
  openclawToken?: string;
  messaging: PushSecretsResult;
}

export async function pushConnectivityProfileToSSM(
  agentName: string,
  region: string,
  profileName: string
): Promise<PushConnectivityProfileResult> {
  const profile = await getConnectivityProfileWithSecrets(profileName);
  if (!profile) {
    throw new Error(`Connectivity profile '${profileName}' not found`);
  }

  let tailscale = false;
  let openclaw = false;
  const failures: string[] = [];

  // Push Tailscale auth key if configured
  if (profile.tailscaleKey) {
    try {
      await pushTailscaleAuthKeyToSSM(agentName, region, profile.tailscaleKey);
      tailscale = true;
    } catch (error) {
      failures.push(`Tailscale: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Push OpenClaw config if any feature needs it.
  // Note: Service start decision is separate (bootstrap-openclaw.sh checks model/channels).
  // Gateway mode 'local' still needs config because gateway runs locally.
  let openclawToken: string | undefined;
  const hasAutomation = profile.automationCronEnabled || profile.automationWebhooksEnabled;
  const gatewayMode = profile.gatewayMode || 'local';
  const hasOpenClawConfig =
    profile.openclawModel ||
    profile.openclawChannels.length > 0 ||
    hasAutomation ||
    gatewayMode !== 'none';

  if (hasOpenClawConfig) {
    const channels: Record<string, boolean> = {};
    for (const channel of profile.openclawChannels) {
      channels[channel] = true;
    }
    const config: OpenClawConfig = {
      model: profile.openclawModel,
      channels,
      dmPolicies: profile.dmPolicies,
      automation: {
        cron: {
          enabled: profile.automationCronEnabled,
          maxConcurrent: profile.automationCronMaxConcurrent,
        },
        webhooks: {
          enabled: profile.automationWebhooksEnabled,
          port: profile.automationWebhooksPort,
        },
      },
      gateway: { mode: gatewayMode },
    };
    try {
      await pushOpenClawConfigToSSM(agentName, region, config);
      // Generate and push gateway auth token (unless gateway is disabled)
      if (gatewayMode !== 'none') {
        openclawToken = await pushOpenClawTokenToSSM(agentName, region);
      }
      openclaw = true;
    } catch (error) {
      failures.push(`OpenClaw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Push messaging credentials
  let messaging: PushSecretsResult;
  try {
    messaging = await pushMessagingCredentialsToSSM(agentName, region, {
      telegramBotToken: profile.telegramToken,
      slackOAuth: profile.slackToken,
      discordOAuth: profile.discordToken,
      googlechatToken: profile.googlechatToken,
      teamsToken: profile.teamsToken,
      matrixToken: profile.matrixToken,
      webchatToken: profile.webchatToken,
      blueBubblesToken: profile.blueBubblesToken,
      zaloToken: profile.zaloToken,
    });
  } catch (error) {
    failures.push(`Messaging: ${error instanceof Error ? error.message : String(error)}`);
    messaging = { pushed: [], skipped: [] };
  }

  if (failures.length > 0) {
    throw new Error(`Partial connectivity push failure: ${failures.join('; ')}`);
  }

  return { tailscale, openclaw, openclawToken, messaging };
}

/**
 * Get the gateway URL for an agent from SSM.
 * Returns null if not found (agent doesn't have Tailscale Serve/Funnel configured or URL not yet stored).
 */
export async function getGatewayURL(agentName: string, region: string): Promise<string | null> {
  const client = await createSSMClient(region);

  try {
    const response = await retryWithBackoff(
      () =>
        client.send(
          new GetParameterCommand({
            Name: `/clawdult/${agentName}/gateway-url`,
          })
        ),
      { transientErrors: SSM_TRANSIENT_ERRORS }
    );
    return response.Parameter?.Value ?? null;
  } catch (error) {
    if (error instanceof ParameterNotFound) {
      return null;
    }
    throw error;
  }
}

/**
 * Store the SageMaker execution role ARN in SSM so the agent can retrieve it.
 */
export async function pushSageMakerRoleArnToSSM(
  agentName: string,
  region: string,
  roleArn: string
): Promise<void> {
  const client = await createSSMClient(region);

  await putParameter(client, {
    name: `/clawdult/${agentName}/sagemaker-role-arn`,
    value: roleArn,
    type: 'String',
    agentName,
  });
}

/**
 * Get the SageMaker execution role ARN for an agent from SSM.
 */
export async function getSageMakerRoleArn(
  agentName: string,
  region: string
): Promise<string | null> {
  const client = await createSSMClient(region);

  try {
    const response = await retryWithBackoff(
      () =>
        client.send(
          new GetParameterCommand({
            Name: `/clawdult/${agentName}/sagemaker-role-arn`,
          })
        ),
      { transientErrors: SSM_TRANSIENT_ERRORS }
    );
    return response.Parameter?.Value ?? null;
  } catch (error) {
    if (error instanceof ParameterNotFound) {
      return null;
    }
    throw error;
  }
}

/**
 * Store workstation type configuration in SSM so the workstation knows its type and capabilities.
 */
export async function pushWorkstationTypeToSSM(
  agentName: string,
  region: string,
  workstationType: { name: string; capabilities: string[]; tools: Record<string, boolean> }
): Promise<void> {
  const client = await createSSMClient(region);

  await putParameter(client, {
    name: `/clawdult/${agentName}/workstation-type`,
    value: JSON.stringify(workstationType),
    type: 'String',
    agentName,
  });
}

export async function pushAgentInstructionsToSSM(
  agentName: string,
  region: string,
  instructions: AgentInstructions
): Promise<void> {
  const client = await createSSMClient(region);

  // Resolve file: references to inline content
  const resolved = { ...instructions };
  if (resolved.instructions?.startsWith('file:')) {
    const filePath = path.resolve(resolved.instructions.slice(5));
    resolved.instructions = await fs.readFile(filePath, 'utf-8');
  }

  await putParameter(client, {
    name: `/clawdult/${agentName}/agent-instructions`,
    value: JSON.stringify(resolved),
    type: 'String',
    agentName,
  });
}

export interface CopySSMResult {
  copied: string[];
  failed: string[];
}

export async function copySSMParameters(
  sourceAgent: string,
  destAgent: string,
  region: string
): Promise<CopySSMResult> {
  const client = await createSSMClient(region);
  const copied: string[] = [];
  const failed: string[] = [];

  const sourcePath = `/clawdult/${sourceAgent}/`;
  let nextToken: string | undefined;

  do {
    const response = await retryWithBackoff(
      () =>
        client.send(
          new GetParametersByPathCommand({
            Path: sourcePath,
            WithDecryption: true,
            Recursive: true,
            NextToken: nextToken,
          })
        ),
      { transientErrors: SSM_TRANSIENT_ERRORS }
    );

    for (const param of response.Parameters || []) {
      if (!param.Name || !param.Value) continue;

      const paramSuffix = param.Name.slice(sourcePath.length);
      const destName = `/clawdult/${destAgent}/${paramSuffix}`;

      try {
        await putParameter(client, {
          name: destName,
          value: param.Value,
          type: (param.Type as 'String' | 'SecureString') || 'SecureString',
          agentName: destAgent,
        });
        copied.push(paramSuffix);
      } catch (error) {
        failed.push(`${paramSuffix}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    nextToken = response.NextToken;
  } while (nextToken);

  return { copied, failed };
}

export { KEY_NAME_MAP };
