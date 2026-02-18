import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CACHE_DIR = path.join(os.homedir(), '.clawdult');
const CACHE_FILE = path.join(CACHE_DIR, '.completion-cache.json');
const CACHE_TTL_MS = 30 * 1000; // 30 seconds

interface CacheData {
  timestamp: number;
  instances: string[];
}

export async function getCachedInstances(): Promise<string[] | null> {
  try {
    const content = await fs.readFile(CACHE_FILE, 'utf-8');
    const data = JSON.parse(content);

    // Validate cache structure
    if (
      typeof data !== 'object' ||
      data === null ||
      typeof data.timestamp !== 'number' ||
      !Array.isArray(data.instances) ||
      !data.instances.every((i: unknown) => typeof i === 'string')
    ) {
      console.error('clawdult: corrupted completion cache, ignoring');
      await fs
        .unlink(CACHE_FILE)
        .catch((err) => console.error('clawdult: failed to remove corrupted cache:', err.message));
      return null;
    }

    if (Date.now() - data.timestamp < CACHE_TTL_MS) {
      return data.instances;
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`clawdult: failed to read completion cache: ${error}`);
    }
    return null;
  }
}

export async function setCachedInstances(instances: string[]): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    const data: CacheData = {
      timestamp: Date.now(),
      instances,
    };
    await fs.writeFile(CACHE_FILE, JSON.stringify(data), 'utf-8');
  } catch (error) {
    console.error(`clawdult: failed to write completion cache: ${error}`);
  }
}
