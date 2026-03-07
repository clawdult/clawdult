import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityModule } from '../schemas/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getPoliciesDir(): string {
  return path.resolve(__dirname, '..', '..', 'policies');
}

interface PolicyStatement {
  Sid: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, unknown>;
}

interface AgentModule {
  statements: PolicyStatement[];
}

interface BoundaryOverrides {
  overrides: Record<string, PolicyStatement>;
}

interface PolicyDocument {
  Version: string;
  Statement: PolicyStatement[];
}

async function loadAgentModule(name: string): Promise<AgentModule> {
  const filePath = path.join(getPoliciesDir(), 'modules', `${name}.json`);
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

async function loadBoundaryBase(): Promise<PolicyDocument> {
  const filePath = path.join(getPoliciesDir(), 'boundaries', 'base.json');
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

async function loadBoundaryOverrides(capability: string): Promise<BoundaryOverrides | null> {
  const filePath = path.join(getPoliciesDir(), 'boundaries', `${capability}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Compose an agent IAM policy from base + capability modules.
 * Replaces the agent name placeholder in resource ARNs.
 */
export async function composeAgentPolicy(
  agentName: string,
  capabilities: CapabilityModule[]
): Promise<string> {
  const base = await loadAgentModule('base');
  const statements = [...base.statements];

  for (const capability of capabilities) {
    const mod = await loadAgentModule(capability);
    statements.push(...mod.statements);
  }

  const policy: PolicyDocument = {
    Version: '2012-10-17',
    Statement: statements,
  };

  let doc = JSON.stringify(policy, null, 2);
  doc = doc.replace(/\$\{aws:PrincipalTag\/clawdult:agent\}/g, agentName);
  return doc;
}

/**
 * Compose a permission boundary from base + capability overrides.
 * Overrides replace base statements by matching Sid.
 */
export async function composeBoundaryPolicy(capabilities: CapabilityModule[]): Promise<string> {
  const boundary = await loadBoundaryBase();

  for (const capability of capabilities) {
    const overrides = await loadBoundaryOverrides(capability);
    if (!overrides) continue;

    for (const [targetSid, replacement] of Object.entries(overrides.overrides)) {
      const idx = boundary.Statement.findIndex((s) => s.Sid === targetSid);
      if (idx !== -1) {
        boundary.Statement[idx] = replacement;
      }
    }
  }

  return JSON.stringify(boundary, null, 2);
}

interface ExtraRole {
  type: string;
  service: string;
}

/**
 * Returns extra IAM roles needed for the given capabilities.
 */
export function getExtraRoles(capabilities: CapabilityModule[]): ExtraRole[] {
  const roles: ExtraRole[] = [];
  if (capabilities.includes('sagemaker')) {
    roles.push({ type: 'sagemaker', service: 'sagemaker.amazonaws.com' });
  }
  return roles;
}
