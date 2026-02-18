import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createProfileStore } from './profile-store.js';
import { storeSecret, getSecret, deleteSecret } from './secrets.js';

const CONNECTIVITY_PROFILES_DIR = path.join(os.homedir(), '.clawdult', 'connectivity-profiles');
const CONNECTIVITY_PROFILE_SERVICE = 'connectivity-profile';

export const GatewayModeSchema = z.enum(['local', 'tailscale-serve', 'tailscale-funnel', 'none']);
export type GatewayMode = z.infer<typeof GatewayModeSchema>;

export const DmPolicySchema = z.enum(['allow', 'receive-only', 'deny']).default('allow');
export type DmPolicy = z.infer<typeof DmPolicySchema>;

export const ConnectivityProfileSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-zA-Z0-9-_]+$/, 'Name must be alphanumeric with hyphens/underscores'),
  createdAt: z.string().datetime(),
  description: z.string().optional(),
  // Tailscale
  hasTailscaleKey: z.boolean().default(false),
  // Gateway mode (requires Tailscale for serve/funnel modes)
  gatewayMode: GatewayModeSchema.default('local'),
  // OpenClaw
  openclawModel: z.string().optional(),
  openclawChannels: z.array(z.string()).default([]),
  // Which channel tokens are configured
  hasDiscordToken: z.boolean().default(false),
  hasSlackToken: z.boolean().default(false),
  hasTelegramToken: z.boolean().default(false),
  hasGooglechatToken: z.boolean().default(false),
  hasTeamsToken: z.boolean().default(false),
  hasMatrixToken: z.boolean().default(false),
  hasWebchatToken: z.boolean().default(false),
  hasBlueBubblesToken: z.boolean().default(false),
  hasZaloToken: z.boolean().default(false),
  // Per-channel DM policies
  dmPolicies: z.record(z.string(), DmPolicySchema).default({}),
  // Automation
  automationCronEnabled: z.boolean().default(false),
  automationCronMaxConcurrent: z.number().int().min(1).max(20).default(5),
  automationWebhooksEnabled: z.boolean().default(false),
  automationWebhooksPort: z.number().int().min(1024).max(65535).default(18790),
});

export type ConnectivityProfile = z.infer<typeof ConnectivityProfileSchema>;

export interface ConnectivityProfileWithSecrets extends ConnectivityProfile {
  tailscaleKey?: string;
  discordToken?: string;
  slackToken?: string;
  telegramToken?: string;
  googlechatToken?: string;
  teamsToken?: string;
  matrixToken?: string;
  webchatToken?: string;
  blueBubblesToken?: string;
  zaloToken?: string;
}

// Secret key types
export type ConnectivitySecretType =
  | 'tailscale'
  | 'discord'
  | 'slack'
  | 'telegram'
  | 'googlechat'
  | 'teams'
  | 'matrix'
  | 'webchat'
  | 'bluebubbles'
  | 'zalo';

const store = createProfileStore<ConnectivityProfile>(
  CONNECTIVITY_PROFILES_DIR,
  ConnectivityProfileSchema
);

function getSecretKey(profileName: string, secretType: string): string {
  return `${profileName}:${secretType}`;
}

export const listConnectivityProfiles = store.list;
export const getConnectivityProfile = store.get;
export const saveConnectivityProfile = store.save;

export async function deleteConnectivityProfile(name: string): Promise<void> {
  await store.delete(name);

  // Delete associated secrets
  for (const secretType of [
    'tailscale',
    'discord',
    'slack',
    'telegram',
    'googlechat',
    'teams',
    'matrix',
    'webchat',
    'bluebubbles',
    'zalo',
  ] as const) {
    await deleteSecret(CONNECTIVITY_PROFILE_SERVICE, getSecretKey(name, secretType));
  }
}

export async function setProfileSecret(
  profileName: string,
  secretType: ConnectivitySecretType,
  value: string
): Promise<void> {
  await storeSecret(CONNECTIVITY_PROFILE_SERVICE, getSecretKey(profileName, secretType), value);

  // Update profile metadata
  const profile = await getConnectivityProfile(profileName);
  if (profile) {
    if (secretType === 'tailscale') {
      profile.hasTailscaleKey = true;
    } else {
      const tokenField =
        `has${secretType.charAt(0).toUpperCase() + secretType.slice(1)}Token` as keyof ConnectivityProfile;
      (profile as Record<string, unknown>)[tokenField] = true;
    }
    await saveConnectivityProfile(profile);
  }
}

export async function getProfileSecret(
  profileName: string,
  secretType: ConnectivitySecretType
): Promise<string | null> {
  return getSecret(CONNECTIVITY_PROFILE_SERVICE, getSecretKey(profileName, secretType));
}

export async function removeProfileSecret(
  profileName: string,
  secretType: ConnectivitySecretType
): Promise<void> {
  await deleteSecret(CONNECTIVITY_PROFILE_SERVICE, getSecretKey(profileName, secretType));

  // Update profile metadata
  const profile = await getConnectivityProfile(profileName);
  if (profile) {
    if (secretType === 'tailscale') {
      profile.hasTailscaleKey = false;
    } else {
      const tokenField =
        `has${secretType.charAt(0).toUpperCase() + secretType.slice(1)}Token` as keyof ConnectivityProfile;
      (profile as Record<string, unknown>)[tokenField] = false;
    }
    await saveConnectivityProfile(profile);
  }
}

export async function getProfileWithSecrets(
  name: string
): Promise<ConnectivityProfileWithSecrets | null> {
  const profile = await getConnectivityProfile(name);
  if (!profile) return null;

  return {
    ...profile,
    tailscaleKey: profile.hasTailscaleKey
      ? (await getProfileSecret(name, 'tailscale')) || undefined
      : undefined,
    discordToken: profile.hasDiscordToken
      ? (await getProfileSecret(name, 'discord')) || undefined
      : undefined,
    slackToken: profile.hasSlackToken
      ? (await getProfileSecret(name, 'slack')) || undefined
      : undefined,
    telegramToken: profile.hasTelegramToken
      ? (await getProfileSecret(name, 'telegram')) || undefined
      : undefined,
    googlechatToken: profile.hasGooglechatToken
      ? (await getProfileSecret(name, 'googlechat')) || undefined
      : undefined,
    teamsToken: profile.hasTeamsToken
      ? (await getProfileSecret(name, 'teams')) || undefined
      : undefined,
    matrixToken: profile.hasMatrixToken
      ? (await getProfileSecret(name, 'matrix')) || undefined
      : undefined,
    webchatToken: profile.hasWebchatToken
      ? (await getProfileSecret(name, 'webchat')) || undefined
      : undefined,
    blueBubblesToken: profile.hasBlueBubblesToken
      ? (await getProfileSecret(name, 'bluebubbles')) || undefined
      : undefined,
    zaloToken: profile.hasZaloToken
      ? (await getProfileSecret(name, 'zalo')) || undefined
      : undefined,
  };
}

export async function createConnectivityProfile(
  name: string,
  config: {
    tailscaleKey?: string;
    gatewayMode?: GatewayMode;
    openclawModel?: string;
    openclawChannels?: string[];
    discordToken?: string;
    slackToken?: string;
    telegramToken?: string;
    googlechatToken?: string;
    teamsToken?: string;
    matrixToken?: string;
    webchatToken?: string;
    blueBubblesToken?: string;
    zaloToken?: string;
    dmPolicies?: Record<string, DmPolicy>;
    automationCronEnabled?: boolean;
    automationCronMaxConcurrent?: number;
    automationWebhooksEnabled?: boolean;
    automationWebhooksPort?: number;
  },
  description?: string
): Promise<ConnectivityProfile> {
  const profile: ConnectivityProfile = {
    name,
    createdAt: new Date().toISOString(),
    description,
    hasTailscaleKey: !!config.tailscaleKey,
    // Smart default: enable gateway via Tailscale when available
    gatewayMode: config.gatewayMode ?? (config.tailscaleKey ? 'tailscale-serve' : 'local'),
    openclawModel: config.openclawModel,
    openclawChannels: config.openclawChannels || [],
    hasDiscordToken: !!config.discordToken,
    hasSlackToken: !!config.slackToken,
    hasTelegramToken: !!config.telegramToken,
    hasGooglechatToken: !!config.googlechatToken,
    hasTeamsToken: !!config.teamsToken,
    hasMatrixToken: !!config.matrixToken,
    hasWebchatToken: !!config.webchatToken,
    hasBlueBubblesToken: !!config.blueBubblesToken,
    hasZaloToken: !!config.zaloToken,
    dmPolicies: config.dmPolicies ?? {},
    automationCronEnabled: config.automationCronEnabled ?? false,
    automationCronMaxConcurrent: config.automationCronMaxConcurrent ?? 5,
    automationWebhooksEnabled: config.automationWebhooksEnabled ?? false,
    automationWebhooksPort: config.automationWebhooksPort ?? 18790,
  };

  await saveConnectivityProfile(profile);

  // Store the actual secrets
  if (config.tailscaleKey) await setProfileSecret(name, 'tailscale', config.tailscaleKey);
  if (config.discordToken) await setProfileSecret(name, 'discord', config.discordToken);
  if (config.slackToken) await setProfileSecret(name, 'slack', config.slackToken);
  if (config.telegramToken) await setProfileSecret(name, 'telegram', config.telegramToken);
  if (config.googlechatToken) await setProfileSecret(name, 'googlechat', config.googlechatToken);
  if (config.teamsToken) await setProfileSecret(name, 'teams', config.teamsToken);
  if (config.matrixToken) await setProfileSecret(name, 'matrix', config.matrixToken);
  if (config.webchatToken) await setProfileSecret(name, 'webchat', config.webchatToken);
  if (config.blueBubblesToken) await setProfileSecret(name, 'bluebubbles', config.blueBubblesToken);
  if (config.zaloToken) await setProfileSecret(name, 'zalo', config.zaloToken);

  return profile;
}

export function getConfiguredDescription(profile: ConnectivityProfile): string {
  const features: string[] = [];
  if (profile.hasTailscaleKey) features.push('Tailscale');
  if (profile.gatewayMode && profile.gatewayMode !== 'local') {
    features.push(`Gateway: ${profile.gatewayMode}`);
  }
  if (profile.openclawChannels.length > 0) {
    features.push(
      ...profile.openclawChannels.map((ch) => ch.charAt(0).toUpperCase() + ch.slice(1))
    );
  }
  if (profile.automationCronEnabled) features.push('Cron');
  if (profile.automationWebhooksEnabled) features.push('Webhooks');
  return features.length > 0 ? features.join(', ') : 'none';
}

export interface ConnectivityValidation {
  valid: boolean;
  errors: string[];
}

export function validateConnectivity(
  profile: ConnectivityProfile,
  hasSshCidr: boolean
): ConnectivityValidation {
  const errors: string[] = [];

  // tailscale-serve/funnel require Tailscale
  if (
    (profile.gatewayMode === 'tailscale-serve' || profile.gatewayMode === 'tailscale-funnel') &&
    !profile.hasTailscaleKey
  ) {
    errors.push(`Gateway mode '${profile.gatewayMode}' requires Tailscale to be configured.`);
  }

  // If no gateway and no tailscale, must have SSH
  if (profile.gatewayMode === 'none' && !profile.hasTailscaleKey && !hasSshCidr) {
    errors.push(
      "No connectivity method available. Configure Tailscale, set allowedSshCidr, or use a gateway mode other than 'none'."
    );
  }

  return { valid: errors.length === 0, errors };
}
