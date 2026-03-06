import os from 'node:os';
import path from 'node:path';
import type { WorkstationType } from '../schemas/config.js';
import { WorkstationTypeSchema } from '../schemas/config.js';
import { createProfileStore } from './profile-store.js';

export const BUILTIN_TYPES: WorkstationType[] = [
  {
    name: 'general-purpose',
    description: 'Standard agent workstation',
    capabilities: [],
    tools: {
      claudeCode: true,
      codex: true,
      grok: false,
      gemini: false,
      playwright: true,
      docker: true,
    },
  },
  {
    name: 'data-science',
    description: 'ML training and data analysis',
    capabilities: ['sagemaker'],
    tools: {
      claudeCode: true,
      codex: true,
      grok: false,
      gemini: false,
      playwright: true,
      docker: true,
    },
  },
  {
    name: 'customer-service',
    description: 'Lightweight messaging agent',
    capabilities: [],
    tools: {
      claudeCode: true,
      codex: false,
      grok: false,
      gemini: false,
      playwright: true,
      docker: false,
    },
  },
];

const customStore = createProfileStore<WorkstationType>(
  path.join(os.homedir(), '.clawdult', 'workstation-types'),
  WorkstationTypeSchema
);

export async function listWorkstationTypes(): Promise<WorkstationType[]> {
  const custom = await customStore.list();
  const customNames = new Set(custom.map((t) => t.name));
  const builtins = BUILTIN_TYPES.filter((t) => !customNames.has(t.name));
  return [...builtins, ...custom].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getWorkstationType(name: string): Promise<WorkstationType | undefined> {
  const custom = await customStore.get(name);
  if (custom) return custom;
  return BUILTIN_TYPES.find((t) => t.name === name);
}

export function isBuiltinType(name: string): boolean {
  return BUILTIN_TYPES.some((t) => t.name === name);
}

export const saveCustomType = customStore.save.bind(customStore);
export const deleteCustomType = customStore.delete.bind(customStore);
