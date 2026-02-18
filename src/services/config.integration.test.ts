import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import type { CosmiconfigResult } from 'cosmiconfig';

// Mock functions
const mockMkdir =
  jest.fn<(path: string, options?: { recursive?: boolean }) => Promise<string | undefined>>();
const mockReadFile = jest.fn<(path: string, encoding?: string) => Promise<string>>();
const mockWriteFile = jest.fn<(path: string, data: string, options?: object) => Promise<void>>();
const mockSearch = jest.fn<() => Promise<CosmiconfigResult>>();
const mockCosmiconfig = jest.fn(() => ({ search: mockSearch }));

// Mock modules BEFORE importing module under test
// Services use: import { promises as fs } from 'node:fs'
jest.unstable_mockModule('node:fs', () => ({
  promises: {
    mkdir: mockMkdir,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
  },
}));

jest.unstable_mockModule('cosmiconfig', () => ({
  cosmiconfig: mockCosmiconfig,
}));

// Dynamic imports AFTER mocking
const {
  loadGlobalConfig,
  saveGlobalConfig,
  ensureConfigDir,
  getConfigDir,
  getLogsDir,
  clearConfigCache,
} = await import('./config.js');
const { customGlobalConfig, minimalGlobalConfig } =
  await import('../__fixtures__/config.fixtures.js');

describe('config.ts integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearConfigCache();
  });

  describe('loadGlobalConfig', () => {
    it('returns config from cosmiconfig when found', async () => {
      mockSearch.mockResolvedValue({
        config: customGlobalConfig,
        filepath: '/path/to/.clawdultrc',
        isEmpty: false,
      });

      const config = await loadGlobalConfig();

      expect(config.defaultRegion).toBe('us-west-2');
      expect(config.defaultInstanceType).toBe('t3.large');
      expect(config.awsProfile).toBe('clawdult-dev');
    });

    it('falls back to ~/.clawdult/config.yaml when cosmiconfig finds nothing', async () => {
      mockSearch.mockResolvedValue(null);
      mockReadFile.mockResolvedValue(`
defaultRegion: eu-west-1
defaultInstanceType: m6i.large
awsProfile: custom-profile
`);

      const config = await loadGlobalConfig();

      expect(config.defaultRegion).toBe('eu-west-1');
      expect(config.defaultInstanceType).toBe('m6i.large');
      expect(config.awsProfile).toBe('custom-profile');
    });

    it('returns schema defaults when no config exists', async () => {
      mockSearch.mockResolvedValue(null);
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });

      const config = await loadGlobalConfig();

      expect(config.defaultRegion).toBe('us-east-1');
      expect(config.defaultInstanceType).toBe('t3.medium');
      expect(config.defaultVolumeSize).toBe(50);
      expect(config.githubAgentAccounts).toEqual([]);
    });

    it('returns schema defaults when cosmiconfig throws', async () => {
      mockSearch.mockRejectedValue(new Error('Search failed'));
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });

      const config = await loadGlobalConfig();

      expect(config.defaultRegion).toBe('us-east-1');
    });

    it('throws when config file is invalid YAML', async () => {
      mockSearch.mockResolvedValue(null);
      mockReadFile.mockResolvedValue('invalid: yaml: content: [');

      await expect(loadGlobalConfig()).rejects.toThrow('Failed to load config');
    });
  });

  describe('saveGlobalConfig', () => {
    it('creates directory and writes YAML config', async () => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);

      await saveGlobalConfig(minimalGlobalConfig);

      expect(mockMkdir).toHaveBeenCalledTimes(2);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.stringContaining('config.yaml'),
        expect.stringContaining('defaultRegion: us-east-1'),
        expect.anything()
      );
    });
  });

  describe('ensureConfigDir', () => {
    it('creates config and logs directories', async () => {
      mockMkdir.mockResolvedValue(undefined);

      await ensureConfigDir();

      expect(mockMkdir).toHaveBeenCalledTimes(2);
      expect(mockMkdir).toHaveBeenNthCalledWith(1, expect.stringContaining('.clawdult'), {
        recursive: true,
      });
      expect(mockMkdir).toHaveBeenNthCalledWith(2, expect.stringContaining('logs'), {
        recursive: true,
      });
    });
  });

  describe('getConfigDir', () => {
    it('returns path to ~/.clawdult', () => {
      const dir = getConfigDir();
      expect(dir).toContain('.clawdult');
      expect(dir).not.toContain('logs');
    });
  });

  describe('getLogsDir', () => {
    it('returns path to ~/.clawdult/logs', () => {
      const dir = getLogsDir();
      expect(dir).toContain('.clawdult');
      expect(dir).toContain('logs');
    });
  });
});
