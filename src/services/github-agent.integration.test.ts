import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { GlobalConfig, GitHubAgentAccount } from '../schemas/config.js';

// Mock functions with explicit types
const mockStoreSecret = jest.fn<(service: string, key: string, value: string) => Promise<void>>();
const mockGetSecret = jest.fn<(service: string, key: string) => Promise<string | null>>();

const mockLoadGlobalConfig = jest.fn<() => Promise<GlobalConfig>>();
const mockSaveGlobalConfig = jest.fn<(config: GlobalConfig) => Promise<void>>();

jest.unstable_mockModule('./secrets.js', () => ({
  storeSecret: mockStoreSecret,
  getSecret: mockGetSecret,
}));

jest.unstable_mockModule('./config.js', () => ({
  loadGlobalConfig: mockLoadGlobalConfig,
  saveGlobalConfig: mockSaveGlobalConfig,
}));

// Mock global fetch
const originalFetch = global.fetch;
const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch;

// Dynamic imports AFTER mocking
const {
  validateToken,
  getNoreplyEmail,
  listAgentAccounts,
  addAgentAccount,
  storeAgentToken,
  getAgentToken,
  getAgentAccount,
} = await import('./github-agent.js');
const {
  sampleGitHubUser,
  sampleGitHubAgentAccount,
  sampleGitHubAgentAccount2,
  minimalGlobalConfig,
} = await import('../__fixtures__/config.fixtures.js');

// Helper to create fresh config to avoid mutation between tests
function createMinimalConfig(): GlobalConfig {
  return { ...minimalGlobalConfig, githubAgentAccounts: [] };
}

function createConfigWithAgents(): GlobalConfig {
  return {
    ...minimalGlobalConfig,
    githubAgentAccounts: [{ ...sampleGitHubAgentAccount }, { ...sampleGitHubAgentAccount2 }],
  };
}

describe('github-agent.ts integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = mockFetch;
    mockLoadGlobalConfig.mockResolvedValue(createMinimalConfig());
    mockSaveGlobalConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('validateToken', () => {
    it('returns user for 200 response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => sampleGitHubUser,
      } as Response);

      const result = await validateToken('ghp_test_token');

      expect(result.login).toBe('test-agent');
      expect(result.id).toBe(12345);
      expect(result.name).toBe('Test Agent');
    });

    it('throws for 401 response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      } as Response);

      await expect(validateToken('invalid_token')).rejects.toThrow(
        'Invalid or expired GitHub token'
      );
    });

    it('throws for other error responses', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      } as Response);

      await expect(validateToken('some_token')).rejects.toThrow(
        'GitHub API error: 500 Internal Server Error'
      );
    });

    it('includes correct Authorization header', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => sampleGitHubUser,
      } as Response);

      await validateToken('ghp_my_token');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/user',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer ghp_my_token',
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'clawdult',
          }),
        })
      );
    });
  });

  describe('getNoreplyEmail', () => {
    it('returns noreply email for username', () => {
      const email = getNoreplyEmail('my-agent');
      expect(email).toBe('my-agent@users.noreply.github.com');
    });
  });

  describe('listAgentAccounts', () => {
    it('returns accounts from config', async () => {
      mockLoadGlobalConfig.mockResolvedValue(createConfigWithAgents());

      const accounts = await listAgentAccounts();

      expect(accounts).toHaveLength(2);
      expect(accounts[0].username).toBe('test-agent');
      expect(accounts[1].username).toBe('another-agent');
    });

    it('returns empty array when no accounts configured', async () => {
      mockLoadGlobalConfig.mockResolvedValue(createMinimalConfig());

      const accounts = await listAgentAccounts();

      expect(accounts).toEqual([]);
    });
  });

  describe('addAgentAccount', () => {
    it('adds new account to config', async () => {
      mockLoadGlobalConfig.mockResolvedValue(createMinimalConfig());

      await addAgentAccount(sampleGitHubAgentAccount);

      expect(mockSaveGlobalConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          githubAgentAccounts: [sampleGitHubAgentAccount],
        })
      );
    });

    it('replaces existing account with same username', async () => {
      mockLoadGlobalConfig.mockResolvedValue(createConfigWithAgents());

      const updatedAccount: GitHubAgentAccount = {
        ...sampleGitHubAgentAccount,
        description: 'Updated description',
      };
      await addAgentAccount(updatedAccount);

      const savedConfig = mockSaveGlobalConfig.mock.calls[0][0];
      expect(savedConfig.githubAgentAccounts).toHaveLength(2);
      const account = savedConfig.githubAgentAccounts.find((a) => a.username === 'test-agent');
      expect(account?.description).toBe('Updated description');
    });

    it('appends new account when username does not exist', async () => {
      mockLoadGlobalConfig.mockResolvedValue({
        ...minimalGlobalConfig,
        githubAgentAccounts: [{ ...sampleGitHubAgentAccount }],
      });

      await addAgentAccount(sampleGitHubAgentAccount2);

      const savedConfig = mockSaveGlobalConfig.mock.calls[0][0];
      expect(savedConfig.githubAgentAccounts).toHaveLength(2);
    });
  });

  describe('storeAgentToken', () => {
    it('delegates to storeSecret with correct service', async () => {
      await storeAgentToken('my-agent', 'ghp_secret_token');

      expect(mockStoreSecret).toHaveBeenCalledWith('github-agent', 'my-agent', 'ghp_secret_token');
    });
  });

  describe('getAgentToken', () => {
    it('delegates to getSecret with correct service', async () => {
      mockGetSecret.mockResolvedValue('ghp_stored_token');

      const token = await getAgentToken('my-agent');

      expect(token).toBe('ghp_stored_token');
      expect(mockGetSecret).toHaveBeenCalledWith('github-agent', 'my-agent');
    });

    it('returns null when token not found', async () => {
      mockGetSecret.mockResolvedValue(null);

      const token = await getAgentToken('nonexistent');

      expect(token).toBeNull();
    });
  });

  describe('getAgentAccount', () => {
    it('returns account when found', async () => {
      mockLoadGlobalConfig.mockResolvedValue(createConfigWithAgents());

      const account = await getAgentAccount('test-agent');

      expect(account?.username).toBe('test-agent');
      expect(account?.email).toBe('test-agent@users.noreply.github.com');
    });

    it('returns null when not found', async () => {
      mockLoadGlobalConfig.mockResolvedValue(createConfigWithAgents());

      const account = await getAgentAccount('nonexistent');

      expect(account).toBeNull();
    });
  });
});
