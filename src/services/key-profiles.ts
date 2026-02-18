import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createProfileStore } from './profile-store.js';
import { storeSecret, getSecret, deleteSecret } from './secrets.js';

const KEY_PROFILES_DIR = path.join(os.homedir(), '.clawdult', 'key-profiles');
const KEY_PROFILE_SERVICE = 'key-profile';

export const KeyProfileSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-zA-Z0-9-_]+$/, 'Name must be alphanumeric with hyphens/underscores'),
  createdAt: z.string().datetime(),
  description: z.string().optional(),
  // Which keys are configured (actual values stored in secrets)
  hasClaudeKey: z.boolean().default(false),
  hasClaudeSetupToken: z.boolean().default(false),
  hasOpenaiKey: z.boolean().default(false),
  hasGrokKey: z.boolean().default(false),
  hasGeminiKey: z.boolean().default(false),
});

export type KeyProfile = z.infer<typeof KeyProfileSchema>;

export interface KeyProfileWithKeys extends KeyProfile {
  claudeKey?: string;
  claudeSetupToken?: string;
  openaiKey?: string;
  grokKey?: string;
  geminiKey?: string;
}

// Key name mapping for SSM
export const KEY_NAME_MAP: Record<string, string> = {
  claude: 'anthropic-api-key',
  'claude-setup-token': 'claude-setup-token',
  openai: 'openai-api-key',
  grok: 'xai-api-key',
  gemini: 'google-api-key',
};

const store = createProfileStore<KeyProfile>(KEY_PROFILES_DIR, KeyProfileSchema);

function getSecretKey(profileName: string, keyType: string): string {
  return `${profileName}:${keyType}`;
}

export const listKeyProfiles = store.list;
export const getKeyProfile = store.get;
export const saveKeyProfile = store.save;

export async function deleteKeyProfile(name: string): Promise<void> {
  await store.delete(name);

  // Delete associated secrets (including claude-setup-token)
  const keyTypes = ['claude', 'claude-setup-token', 'openai', 'grok', 'gemini'];
  for (const keyType of keyTypes) {
    await deleteSecret(KEY_PROFILE_SERVICE, getSecretKey(name, keyType));
  }
}

export async function setProfileKey(
  profileName: string,
  keyType: 'claude' | 'claude-setup-token' | 'openai' | 'grok' | 'gemini',
  value: string
): Promise<void> {
  await storeSecret(KEY_PROFILE_SERVICE, getSecretKey(profileName, keyType), value);

  // Update profile metadata
  const profile = await getKeyProfile(profileName);
  if (profile) {
    const keyField =
      keyType === 'claude-setup-token'
        ? 'hasClaudeSetupToken'
        : (`has${keyType.charAt(0).toUpperCase() + keyType.slice(1)}Key` as keyof KeyProfile);
    (profile as Record<string, unknown>)[keyField] = true;
    await saveKeyProfile(profile);
  }
}

export async function getProfileKey(
  profileName: string,
  keyType: 'claude' | 'claude-setup-token' | 'openai' | 'grok' | 'gemini'
): Promise<string | null> {
  return getSecret(KEY_PROFILE_SERVICE, getSecretKey(profileName, keyType));
}

export async function removeProfileKey(
  profileName: string,
  keyType: 'claude' | 'claude-setup-token' | 'openai' | 'grok' | 'gemini'
): Promise<void> {
  await deleteSecret(KEY_PROFILE_SERVICE, getSecretKey(profileName, keyType));

  // Update profile metadata
  const profile = await getKeyProfile(profileName);
  if (profile) {
    const keyField =
      keyType === 'claude-setup-token'
        ? 'hasClaudeSetupToken'
        : (`has${keyType.charAt(0).toUpperCase() + keyType.slice(1)}Key` as keyof KeyProfile);
    (profile as Record<string, unknown>)[keyField] = false;
    await saveKeyProfile(profile);
  }
}

export async function getProfileWithKeys(name: string): Promise<KeyProfileWithKeys | null> {
  const profile = await getKeyProfile(name);
  if (!profile) return null;

  return {
    ...profile,
    claudeKey: profile.hasClaudeKey
      ? (await getProfileKey(name, 'claude')) || undefined
      : undefined,
    claudeSetupToken: profile.hasClaudeSetupToken
      ? (await getProfileKey(name, 'claude-setup-token')) || undefined
      : undefined,
    openaiKey: profile.hasOpenaiKey
      ? (await getProfileKey(name, 'openai')) || undefined
      : undefined,
    grokKey: profile.hasGrokKey ? (await getProfileKey(name, 'grok')) || undefined : undefined,
    geminiKey: profile.hasGeminiKey
      ? (await getProfileKey(name, 'gemini')) || undefined
      : undefined,
  };
}

export async function createKeyProfile(
  name: string,
  keys: {
    claude?: string;
    claudeSetupToken?: string;
    openai?: string;
    grok?: string;
    gemini?: string;
  },
  description?: string
): Promise<KeyProfile> {
  const profile: KeyProfile = {
    name,
    createdAt: new Date().toISOString(),
    description,
    hasClaudeKey: !!keys.claude,
    hasClaudeSetupToken: !!keys.claudeSetupToken,
    hasOpenaiKey: !!keys.openai,
    hasGrokKey: !!keys.grok,
    hasGeminiKey: !!keys.gemini,
  };

  await saveKeyProfile(profile);

  // Store the actual keys
  if (keys.claude) await setProfileKey(name, 'claude', keys.claude);
  if (keys.claudeSetupToken) await setProfileKey(name, 'claude-setup-token', keys.claudeSetupToken);
  if (keys.openai) await setProfileKey(name, 'openai', keys.openai);
  if (keys.grok) await setProfileKey(name, 'grok', keys.grok);
  if (keys.gemini) await setProfileKey(name, 'gemini', keys.gemini);

  return profile;
}

export function getConfiguredKeysDescription(profile: KeyProfile): string {
  const keys: string[] = [];
  if (profile.hasClaudeSetupToken) {
    keys.push('Claude (subscription)');
  } else if (profile.hasClaudeKey) {
    keys.push('Claude (API)');
  }
  if (profile.hasOpenaiKey) keys.push('OpenAI');
  if (profile.hasGrokKey) keys.push('Grok');
  if (profile.hasGeminiKey) keys.push('Gemini');
  return keys.length > 0 ? keys.join(', ') : 'none';
}
