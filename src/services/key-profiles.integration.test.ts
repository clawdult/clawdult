import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock functions for secrets
const mockStoreSecret = jest.fn<(service: string, key: string, value: string) => Promise<void>>();
const mockGetSecret = jest.fn<(service: string, key: string) => Promise<string | null>>();
const mockDeleteSecret = jest.fn<(service: string, key: string) => Promise<void>>();

// Mock functions for fs
const mockMkdir =
  jest.fn<(path: string, options?: { recursive?: boolean }) => Promise<string | undefined>>();
const mockReadFile = jest.fn<(path: string, encoding?: string) => Promise<string>>();
const mockWriteFile =
  jest.fn<(path: string, data: string, options?: { mode?: number }) => Promise<void>>();
const mockReaddir = jest.fn<(path: string) => Promise<string[]>>();
const mockUnlink = jest.fn<(path: string) => Promise<void>>();

jest.unstable_mockModule('./secrets.js', () => ({
  storeSecret: mockStoreSecret,
  getSecret: mockGetSecret,
  deleteSecret: mockDeleteSecret,
}));

// Services use: import { promises as fs } from 'node:fs'
jest.unstable_mockModule('node:fs', () => ({
  promises: {
    mkdir: mockMkdir,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    readdir: mockReaddir,
    unlink: mockUnlink,
  },
}));

// Dynamic imports AFTER mocking
const {
  listKeyProfiles,
  getKeyProfile,
  saveKeyProfile,
  deleteKeyProfile,
  setProfileKey,
  getProfileKey,
  removeProfileKey,
  getProfileWithKeys,
  createKeyProfile,
  getConfiguredKeysDescription,
  KEY_NAME_MAP,
} = await import('./key-profiles.js');
const { sampleKeyProfile, sampleKeyProfile2, minimalKeyProfile, sampleApiKeys } =
  await import('../__fixtures__/profile.fixtures.js');

describe('key-profiles.ts integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockStoreSecret.mockResolvedValue(undefined);
    mockGetSecret.mockResolvedValue(null);
    mockDeleteSecret.mockResolvedValue(undefined);
  });

  describe('listKeyProfiles', () => {
    it('returns sorted profiles', async () => {
      mockReaddir.mockResolvedValue(['prod-profile.json', 'dev-profile.json', 'minimal.json']);
      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('dev-profile')) return JSON.stringify(sampleKeyProfile);
        if (path.includes('prod-profile')) return JSON.stringify(sampleKeyProfile2);
        if (path.includes('minimal')) return JSON.stringify(minimalKeyProfile);
        throw new Error('Not found');
      });

      const profiles = await listKeyProfiles();

      expect(profiles).toHaveLength(3);
      expect(profiles[0].name).toBe('dev-profile');
      expect(profiles[1].name).toBe('minimal');
      expect(profiles[2].name).toBe('prod-profile');
    });

    it('skips non-JSON files', async () => {
      mockReaddir.mockResolvedValue(['dev-profile.json', 'readme.txt', '.DS_Store']);
      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('dev-profile')) return JSON.stringify(sampleKeyProfile);
        throw new Error('Not found');
      });

      const profiles = await listKeyProfiles();

      expect(profiles).toHaveLength(1);
      expect(profiles[0].name).toBe('dev-profile');
    });

    it('skips invalid JSON files', async () => {
      mockReaddir.mockResolvedValue(['good.json', 'bad.json']);
      mockReadFile.mockImplementation(async (path: string) => {
        if (path.includes('good')) return JSON.stringify(sampleKeyProfile);
        if (path.includes('bad')) return '{ invalid json }';
        throw new Error('Not found');
      });

      const profiles = await listKeyProfiles();

      expect(profiles).toHaveLength(1);
    });

    it('returns empty array when directory read fails', async () => {
      mockReaddir.mockRejectedValue({ code: 'ENOENT' });

      const profiles = await listKeyProfiles();

      expect(profiles).toEqual([]);
    });
  });

  describe('getKeyProfile', () => {
    it('returns profile when exists', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify(sampleKeyProfile));

      const profile = await getKeyProfile('dev-profile');

      expect(profile).toEqual(sampleKeyProfile);
    });

    it('returns null for non-existent profile', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });

      const profile = await getKeyProfile('nonexistent');

      expect(profile).toBeNull();
    });

    it('throws for invalid JSON', async () => {
      mockReadFile.mockResolvedValue('not valid json');

      await expect(getKeyProfile('corrupted')).rejects.toThrow();
    });
  });

  describe('saveKeyProfile', () => {
    it('creates directory and writes JSON', async () => {
      mockWriteFile.mockResolvedValue(undefined);

      await saveKeyProfile(sampleKeyProfile);

      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('dev-profile.json'),
        expect.stringContaining('"name": "dev-profile"'),
        { mode: 0o600 }
      );
    });
  });

  describe('deleteKeyProfile', () => {
    it('removes file and all secrets', async () => {
      mockUnlink.mockResolvedValue(undefined);

      await deleteKeyProfile('test-profile');

      expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('test-profile.json'));

      expect(mockDeleteSecret).toHaveBeenCalledWith('key-profile', 'test-profile:claude');
      expect(mockDeleteSecret).toHaveBeenCalledWith('key-profile', 'test-profile:openai');
      expect(mockDeleteSecret).toHaveBeenCalledWith('key-profile', 'test-profile:grok');
      expect(mockDeleteSecret).toHaveBeenCalledWith('key-profile', 'test-profile:gemini');
    });

    it('ignores file not found error', async () => {
      mockUnlink.mockRejectedValue({ code: 'ENOENT' });

      await expect(deleteKeyProfile('nonexistent')).resolves.toBeUndefined();
    });
  });

  describe('setProfileKey', () => {
    it('stores in secrets and updates metadata', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify(sampleKeyProfile));
      mockWriteFile.mockResolvedValue(undefined);

      await setProfileKey('dev-profile', 'grok', 'xai-new-key');

      expect(mockStoreSecret).toHaveBeenCalledWith(
        'key-profile',
        'dev-profile:grok',
        'xai-new-key'
      );

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('dev-profile.json'),
        expect.stringContaining('"hasGrokKey": true'),
        { mode: 0o600 }
      );
    });

    it('handles non-existent profile gracefully', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });

      await setProfileKey('nonexistent', 'claude', 'key');

      expect(mockStoreSecret).toHaveBeenCalled();
    });
  });

  describe('getProfileKey', () => {
    it('returns key from secrets', async () => {
      mockGetSecret.mockResolvedValue('stored-api-key');

      const key = await getProfileKey('dev-profile', 'claude');

      expect(key).toBe('stored-api-key');
      expect(mockGetSecret).toHaveBeenCalledWith('key-profile', 'dev-profile:claude');
    });

    it('returns null when key not found', async () => {
      mockGetSecret.mockResolvedValue(null);

      const key = await getProfileKey('dev-profile', 'gemini');

      expect(key).toBeNull();
    });
  });

  describe('removeProfileKey', () => {
    it('deletes from secrets and updates metadata', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify(sampleKeyProfile));
      mockWriteFile.mockResolvedValue(undefined);

      await removeProfileKey('dev-profile', 'claude');

      expect(mockDeleteSecret).toHaveBeenCalledWith('key-profile', 'dev-profile:claude');
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('dev-profile.json'),
        expect.stringContaining('"hasClaudeKey": false'),
        { mode: 0o600 }
      );
    });
  });

  describe('getProfileWithKeys', () => {
    it('returns profile with all keys populated', async () => {
      const profileWithAllKeys = {
        ...sampleKeyProfile,
        hasClaudeKey: true,
        hasOpenaiKey: true,
        hasGrokKey: true,
        hasGeminiKey: true,
      };
      mockReadFile.mockResolvedValue(JSON.stringify(profileWithAllKeys));
      mockGetSecret.mockImplementation(async (_service: string, key: string) => {
        if (key.includes('claude')) return sampleApiKeys.claude;
        if (key.includes('openai')) return sampleApiKeys.openai;
        if (key.includes('grok')) return sampleApiKeys.grok;
        if (key.includes('gemini')) return sampleApiKeys.gemini;
        return null;
      });

      const profile = await getProfileWithKeys('dev-profile');

      expect(profile).not.toBeNull();
      expect(profile?.claudeKey).toBe(sampleApiKeys.claude);
      expect(profile?.openaiKey).toBe(sampleApiKeys.openai);
      expect(profile?.grokKey).toBe(sampleApiKeys.grok);
      expect(profile?.geminiKey).toBe(sampleApiKeys.gemini);
    });

    it('returns null for non-existent profile', async () => {
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });

      const profile = await getProfileWithKeys('nonexistent');

      expect(profile).toBeNull();
    });

    it('only fetches keys that are marked as present', async () => {
      mockReadFile.mockResolvedValue(JSON.stringify(minimalKeyProfile));

      const profile = await getProfileWithKeys('minimal');

      expect(profile).not.toBeNull();
      expect(profile?.claudeKey).toBeUndefined();
      expect(profile?.openaiKey).toBeUndefined();
      expect(mockGetSecret).not.toHaveBeenCalled();
    });
  });

  describe('createKeyProfile', () => {
    it('creates profile and stores keys', async () => {
      mockWriteFile.mockResolvedValue(undefined);
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });

      const profile = await createKeyProfile(
        'new-profile',
        { claude: sampleApiKeys.claude, openai: sampleApiKeys.openai },
        'Test profile'
      );

      expect(profile.name).toBe('new-profile');
      expect(profile.description).toBe('Test profile');
      expect(profile.hasClaudeKey).toBe(true);
      expect(profile.hasOpenaiKey).toBe(true);
      expect(profile.hasGrokKey).toBe(false);
      expect(profile.hasGeminiKey).toBe(false);

      expect(mockWriteFile).toHaveBeenCalled();

      expect(mockStoreSecret).toHaveBeenCalledWith(
        'key-profile',
        'new-profile:claude',
        sampleApiKeys.claude
      );
      expect(mockStoreSecret).toHaveBeenCalledWith(
        'key-profile',
        'new-profile:openai',
        sampleApiKeys.openai
      );
    });
  });

  describe('getConfiguredKeysDescription', () => {
    it('returns comma-separated list of configured keys', () => {
      const desc = getConfiguredKeysDescription(sampleKeyProfile);
      expect(desc).toBe('Claude (API), OpenAI');
    });

    it('returns "none" when no keys configured', () => {
      const desc = getConfiguredKeysDescription(minimalKeyProfile);
      expect(desc).toBe('none');
    });

    it('returns all four when all configured', () => {
      const desc = getConfiguredKeysDescription(sampleKeyProfile2);
      expect(desc).toBe('Claude (API), OpenAI, Grok, Gemini');
    });
  });

  describe('KEY_NAME_MAP', () => {
    it('maps key types to SSM parameter names', () => {
      expect(KEY_NAME_MAP.claude).toBe('anthropic-api-key');
      expect(KEY_NAME_MAP.openai).toBe('openai-api-key');
      expect(KEY_NAME_MAP.grok).toBe('xai-api-key');
      expect(KEY_NAME_MAP.gemini).toBe('google-api-key');
    });
  });
});
