import { jest } from '@jest/globals';
import { getCachedInstances, setCachedInstances } from './cache.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CACHE_FILE = path.join(os.homedir(), '.clawdult', '.completion-cache.json');

describe('completion cache', () => {
  let originalContent: string | null = null;

  beforeEach(async () => {
    // Preserve existing cache if present
    try {
      originalContent = await fs.readFile(CACHE_FILE, 'utf-8');
    } catch {
      originalContent = null;
    }
    // Remove cache for tests
    await fs.unlink(CACHE_FILE).catch(() => {});
  });

  afterEach(async () => {
    // Restore original cache
    if (originalContent !== null) {
      await fs.writeFile(CACHE_FILE, originalContent, 'utf-8');
    } else {
      await fs.unlink(CACHE_FILE).catch(() => {});
    }
  });

  it('returns null when cache does not exist', async () => {
    expect(await getCachedInstances()).toBeNull();
  });

  it('returns cached instances within TTL', async () => {
    await setCachedInstances(['instance-1', 'instance-2']);
    expect(await getCachedInstances()).toEqual(['instance-1', 'instance-2']);
  });

  it('returns null when cache is corrupted (not JSON)', async () => {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, 'not valid json', 'utf-8');

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getCachedInstances()).toBeNull();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('returns null when cache is corrupted (not an object)', async () => {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, '"just a string"', 'utf-8');

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getCachedInstances()).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith('clawdult: corrupted completion cache, ignoring');
    consoleSpy.mockRestore();
  });

  it('returns null when instances is not an array', async () => {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(
      CACHE_FILE,
      JSON.stringify({ timestamp: Date.now(), instances: 'not-array' }),
      'utf-8'
    );

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getCachedInstances()).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith('clawdult: corrupted completion cache, ignoring');
    consoleSpy.mockRestore();
  });

  it('returns null when instances contains non-strings', async () => {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(
      CACHE_FILE,
      JSON.stringify({ timestamp: Date.now(), instances: [1, 2, 3] }),
      'utf-8'
    );

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getCachedInstances()).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith('clawdult: corrupted completion cache, ignoring');
    consoleSpy.mockRestore();
  });

  it('returns null when timestamp is missing', async () => {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, JSON.stringify({ instances: ['instance-1'] }), 'utf-8');

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getCachedInstances()).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith('clawdult: corrupted completion cache, ignoring');
    consoleSpy.mockRestore();
  });

  it('deletes corrupted cache file', async () => {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.writeFile(CACHE_FILE, '"corrupted"', 'utf-8');

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await getCachedInstances();
    consoleSpy.mockRestore();

    // File should be deleted
    await expect(fs.access(CACHE_FILE)).rejects.toThrow();
  });

  it('returns null when cache is expired', async () => {
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    // Set timestamp to 1 minute ago (expired since TTL is 30 seconds)
    const data = { timestamp: Date.now() - 60000, instances: ['old-instance'] };
    await fs.writeFile(CACHE_FILE, JSON.stringify(data), 'utf-8');

    expect(await getCachedInstances()).toBeNull();
  });

  it('handles empty instances array', async () => {
    await setCachedInstances([]);
    expect(await getCachedInstances()).toEqual([]);
  });
});
