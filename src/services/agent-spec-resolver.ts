import type {
  AgentInstructions,
  AgentSpec,
  GlobalConfig,
  GitHubAgentAccount,
  WorkstationType,
} from '../schemas/config.js';
import type { KeyProfile } from './key-profiles.js';
import type { ConnectivityProfile } from './connectivity-profiles.js';
import type { InfrastructureResult } from '../cli/commands/create/wizard-steps.js';
import { getWorkstationType } from './workstation-types.js';
import { getKeyProfile } from './key-profiles.js';
import { getConnectivityProfile } from './connectivity-profiles.js';
import { listAgentAccounts } from './github-agent.js';

export interface ResolvedAgentSpec {
  name: string;
  workstationType: WorkstationType;
  keyProfile: KeyProfile | null;
  connectivity: ConnectivityProfile | null;
  github: GitHubAgentAccount | null;
  infrastructure: InfrastructureResult;
  instructions: AgentInstructions | null;
}

export async function resolveAgentSpec(
  spec: AgentSpec,
  globalConfig: GlobalConfig
): Promise<ResolvedAgentSpec> {
  // Resolve workstation type
  const workstationType = await getWorkstationType(spec.workstationType);
  if (!workstationType) {
    throw new Error(
      `Workstation type '${spec.workstationType}' not found. Run 'clawdult profiles types list' to see available types.`
    );
  }

  // Resolve key profile
  let keyProfile: KeyProfile | null = null;
  if (spec.keyProfile) {
    keyProfile = await getKeyProfile(spec.keyProfile);
    if (!keyProfile) {
      throw new Error(
        `Key profile '${spec.keyProfile}' not found. Run 'clawdult profiles keys list' to see available profiles.`
      );
    }
  }

  // Resolve connectivity profile
  let connectivity: ConnectivityProfile | null = null;
  if (spec.connectivityProfile) {
    connectivity = await getConnectivityProfile(spec.connectivityProfile);
    if (!connectivity) {
      throw new Error(
        `Connectivity profile '${spec.connectivityProfile}' not found. Run 'clawdult profiles connectivity list' to see available profiles.`
      );
    }
  }

  // Resolve GitHub agent
  let github: GitHubAgentAccount | null = null;
  if (spec.github) {
    const accounts = await listAgentAccounts();
    github = accounts.find((a) => a.username === spec.github) ?? null;
    if (!github) {
      const available = accounts.map((a) => a.username);
      throw new Error(
        `GitHub agent '${spec.github}' not found. Available: [${available.join(', ')}]`
      );
    }
  }

  // Resolve infrastructure with defaults
  const infrastructure: InfrastructureResult = {
    instanceType: spec.instanceType ?? globalConfig.defaultInstanceType,
    region: spec.region ?? globalConfig.defaultRegion,
    volumeSize: spec.volumeSize ?? globalConfig.defaultVolumeSize,
  };

  return {
    name: spec.name,
    workstationType,
    keyProfile,
    connectivity,
    github,
    infrastructure,
    instructions: spec.instructions ?? null,
  };
}
