import type { WorkstationType } from '../schemas/config.js';

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

export function listWorkstationTypes(): WorkstationType[] {
  return BUILTIN_TYPES;
}

export function getWorkstationType(name: string): WorkstationType | undefined {
  return BUILTIN_TYPES.find((t) => t.name === name);
}
