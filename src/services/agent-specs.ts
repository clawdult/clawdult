import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { AgentSpecSchema } from '../schemas/config.js';
import type { AgentSpec } from '../schemas/config.js';

const SPECS_DIR = path.join(os.homedir(), '.clawdult', 'agent-specs');

async function ensureDir(): Promise<void> {
  await fs.mkdir(SPECS_DIR, { recursive: true });
}

function getPath(name: string): string {
  return path.join(SPECS_DIR, `${name}.yaml`);
}

export async function listAgentSpecs(): Promise<AgentSpec[]> {
  await ensureDir();

  let files: string[];
  try {
    files = await fs.readdir(SPECS_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const specs: AgentSpec[] = [];
  for (const file of files) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    try {
      const content = await fs.readFile(path.join(SPECS_DIR, file), 'utf-8');
      const spec = AgentSpecSchema.parse(YAML.parse(content));
      specs.push(spec);
    } catch (error) {
      process.stderr.write(
        `Warning: Failed to load spec ${file}: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  return specs.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAgentSpec(name: string): Promise<AgentSpec | null> {
  try {
    const content = await fs.readFile(getPath(name), 'utf-8');
    return AgentSpecSchema.parse(YAML.parse(content));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function saveAgentSpec(spec: AgentSpec): Promise<void> {
  await ensureDir();
  await fs.writeFile(getPath(spec.name), YAML.stringify(spec), { mode: 0o600 });
}

export async function deleteAgentSpec(name: string): Promise<void> {
  try {
    await fs.unlink(getPath(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

export async function loadAgentSpecFile(filePath: string): Promise<AgentSpec> {
  const resolved = path.resolve(filePath);
  const content = await fs.readFile(resolved, 'utf-8');
  return AgentSpecSchema.parse(YAML.parse(content));
}
