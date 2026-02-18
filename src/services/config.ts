import { cosmiconfig } from 'cosmiconfig';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'yaml';
import { GlobalConfig, GlobalConfigSchema } from '../schemas/config.js';

const explorer = cosmiconfig('clawdult', {
  searchPlaces: [
    'package.json',
    '.clawdultrc',
    '.clawdultrc.json',
    '.clawdultrc.yaml',
    '.clawdultrc.yml',
    '.clawdult.config.js',
    'clawdult.config.js',
  ],
});

const CONFIG_DIR = path.join(os.homedir(), '.clawdult');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.yaml');

let configCache: GlobalConfig | null = null;

export async function ensureConfigDir(): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.mkdir(path.join(CONFIG_DIR, 'logs'), { recursive: true });
}

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  if (configCache) return configCache;

  try {
    const result = await explorer.search();
    if (result?.config) {
      configCache = GlobalConfigSchema.parse(result.config);
      return configCache;
    }
  } catch (error) {
    console.error(
      'clawdult: failed to parse config:',
      error instanceof Error ? error.message : String(error)
    );
    // Fall through to defaults
  }

  try {
    const content = await fs.readFile(CONFIG_FILE, 'utf-8');
    const parsed = yaml.parse(content);
    configCache = GlobalConfigSchema.parse(parsed);
    return configCache;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      configCache = GlobalConfigSchema.parse({});
      return configCache;
    }
    throw new Error(
      `Failed to load config from ${CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  configCache = null;
  await ensureConfigDir();
  const content = yaml.stringify(config);
  await fs.writeFile(CONFIG_FILE, content, { encoding: 'utf-8', mode: 0o600 });
}

export function clearConfigCache(): void {
  configCache = null;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getLogsDir(): string {
  return path.join(CONFIG_DIR, 'logs');
}
