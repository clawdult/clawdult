import { storeSecret, getSecret } from './secrets.js';
import { loadGlobalConfig, saveGlobalConfig } from './config.js';
import type { GitHubAgentAccount } from '../schemas/config.js';

const GITHUB_SERVICE = 'github-agent';

export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
}

/**
 * Validate a GitHub token by calling the GitHub API directly.
 * Returns the user info if valid, throws if invalid.
 */
export async function validateToken(token: string): Promise<GitHubUser> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'clawdult',
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Invalid or expired GitHub token');
    }
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const user = (await response.json()) as GitHubUser;
  return user;
}

/**
 * Get the noreply email for a GitHub username.
 */
export function getNoreplyEmail(username: string): string {
  return `${username}@users.noreply.github.com`;
}

/**
 * List all stored GitHub agent accounts from global config.
 */
export async function listAgentAccounts(): Promise<GitHubAgentAccount[]> {
  const config = await loadGlobalConfig();
  return config.githubAgentAccounts ?? [];
}

/**
 * Add a new agent account to the registry.
 */
export async function addAgentAccount(account: GitHubAgentAccount): Promise<void> {
  const config = await loadGlobalConfig();
  const accounts = config.githubAgentAccounts ?? [];

  // Replace if account with same username exists
  const existingIndex = accounts.findIndex((a) => a.username === account.username);
  if (existingIndex >= 0) {
    accounts[existingIndex] = account;
  } else {
    accounts.push(account);
  }

  await saveGlobalConfig({
    ...config,
    githubAgentAccounts: accounts,
  });
}

/**
 * Store a GitHub agent's PAT in the secrets service.
 */
export async function storeAgentToken(username: string, token: string): Promise<void> {
  await storeSecret(GITHUB_SERVICE, username, token);
}

/**
 * Retrieve a GitHub agent's PAT from the secrets service.
 */
export async function getAgentToken(username: string): Promise<string | null> {
  return getSecret(GITHUB_SERVICE, username);
}

/**
 * Get a stored agent account by username.
 */
export async function getAgentAccount(username: string): Promise<GitHubAgentAccount | null> {
  const accounts = await listAgentAccounts();
  return accounts.find((a) => a.username === username) ?? null;
}
