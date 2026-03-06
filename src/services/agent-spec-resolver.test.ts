import { jest } from '@jest/globals';
import type { AgentSpec, GlobalConfig } from '../schemas/config.js';

// --- Mocks ---

jest.unstable_mockModule('./workstation-types.js', () => ({
  getWorkstationType: jest.fn(),
}));

jest.unstable_mockModule('./key-profiles.js', () => ({
  getKeyProfile: jest.fn(),
}));

jest.unstable_mockModule('./connectivity-profiles.js', () => ({
  getConnectivityProfile: jest.fn(),
}));

jest.unstable_mockModule('./github-agent.js', () => ({
  listAgentAccounts: jest.fn(),
}));

const { resolveAgentSpec } = await import('./agent-spec-resolver.js');
const { getWorkstationType } = (await import('./workstation-types.js')) as unknown as {
  getWorkstationType: jest.MockedFunction<(name: string) => Promise<unknown>>;
};
const { getKeyProfile } = (await import('./key-profiles.js')) as unknown as {
  getKeyProfile: jest.MockedFunction<(name: string) => Promise<unknown>>;
};
const { getConnectivityProfile } = (await import('./connectivity-profiles.js')) as unknown as {
  getConnectivityProfile: jest.MockedFunction<(name: string) => Promise<unknown>>;
};
const { listAgentAccounts } = (await import('./github-agent.js')) as unknown as {
  listAgentAccounts: jest.MockedFunction<() => Promise<unknown[]>>;
};

const mockGlobalConfig: GlobalConfig = {
  defaultRegion: 'us-east-1',
  defaultInstanceType: 't3.medium',
  defaultVolumeSize: 50,
  sshKeyPaths: {},
  logsDirectory: '~/.clawdult/logs',
  githubAgentAccounts: [],
};

const mockWorkstationType = {
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
};

describe('resolveAgentSpec', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getWorkstationType.mockResolvedValue(mockWorkstationType);
    getKeyProfile.mockResolvedValue(null);
    getConnectivityProfile.mockResolvedValue(null);
    listAgentAccounts.mockResolvedValue([]);
  });

  it('resolves a minimal spec', async () => {
    const spec: AgentSpec = {
      name: 'test-agent',
      workstationType: 'general-purpose',
    };

    const resolved = await resolveAgentSpec(spec, mockGlobalConfig);

    expect(resolved.name).toBe('test-agent');
    expect(resolved.workstationType).toEqual(mockWorkstationType);
    expect(resolved.keyProfile).toBeNull();
    expect(resolved.connectivity).toBeNull();
    expect(resolved.github).toBeNull();
    expect(resolved.instructions).toBeNull();
    expect(resolved.infrastructure).toEqual({
      instanceType: 't3.medium',
      region: 'us-east-1',
      volumeSize: 50,
    });
  });

  it('uses spec overrides for infrastructure', async () => {
    const spec: AgentSpec = {
      name: 'test-agent',
      workstationType: 'general-purpose',
      instanceType: 't3.xlarge',
      region: 'eu-west-1',
      volumeSize: 200,
    };

    const resolved = await resolveAgentSpec(spec, mockGlobalConfig);

    expect(resolved.infrastructure).toEqual({
      instanceType: 't3.xlarge',
      region: 'eu-west-1',
      volumeSize: 200,
    });
  });

  it('resolves key profile by name', async () => {
    const mockProfile = { name: 'prod-keys', hasClaudeKey: true };
    getKeyProfile.mockResolvedValue(mockProfile);

    const spec: AgentSpec = {
      name: 'test-agent',
      workstationType: 'general-purpose',
      keyProfile: 'prod-keys',
    };

    const resolved = await resolveAgentSpec(spec, mockGlobalConfig);
    expect(resolved.keyProfile).toEqual(mockProfile);
  });

  it('throws when workstation type not found', async () => {
    getWorkstationType.mockResolvedValue(undefined);

    const spec: AgentSpec = {
      name: 'test-agent',
      workstationType: 'nonexistent',
    };

    await expect(resolveAgentSpec(spec, mockGlobalConfig)).rejects.toThrow(
      /Workstation type 'nonexistent' not found/
    );
  });

  it('throws when key profile not found', async () => {
    getKeyProfile.mockResolvedValue(null);

    const spec: AgentSpec = {
      name: 'test-agent',
      workstationType: 'general-purpose',
      keyProfile: 'missing-profile',
    };

    await expect(resolveAgentSpec(spec, mockGlobalConfig)).rejects.toThrow(
      /Key profile 'missing-profile' not found/
    );
  });

  it('throws when connectivity profile not found', async () => {
    getConnectivityProfile.mockResolvedValue(null);

    const spec: AgentSpec = {
      name: 'test-agent',
      workstationType: 'general-purpose',
      connectivityProfile: 'missing-conn',
    };

    await expect(resolveAgentSpec(spec, mockGlobalConfig)).rejects.toThrow(
      /Connectivity profile 'missing-conn' not found/
    );
  });

  it('throws when GitHub agent not found', async () => {
    listAgentAccounts.mockResolvedValue([
      { username: 'other-bot', email: 'other@example.com', createdAt: new Date().toISOString() },
    ]);

    const spec: AgentSpec = {
      name: 'test-agent',
      workstationType: 'general-purpose',
      github: 'missing-bot',
    };

    await expect(resolveAgentSpec(spec, mockGlobalConfig)).rejects.toThrow(
      /GitHub agent 'missing-bot' not found.*Available:.*other-bot/
    );
  });

  it('resolves GitHub agent by username', async () => {
    const account = {
      username: 'my-bot',
      email: 'bot@example.com',
      createdAt: new Date().toISOString(),
    };
    listAgentAccounts.mockResolvedValue([account]);

    const spec: AgentSpec = {
      name: 'test-agent',
      workstationType: 'general-purpose',
      github: 'my-bot',
    };

    const resolved = await resolveAgentSpec(spec, mockGlobalConfig);
    expect(resolved.github).toEqual(account);
  });

  it('passes through instructions from spec', async () => {
    const spec: AgentSpec = {
      name: 'test-agent',
      workstationType: 'general-purpose',
      instructions: {
        purpose: 'Test purpose',
        repos: [{ url: 'org/repo' }],
        cron: [],
      },
    };

    const resolved = await resolveAgentSpec(spec, mockGlobalConfig);
    expect(resolved.instructions?.purpose).toBe('Test purpose');
    expect(resolved.instructions?.repos).toHaveLength(1);
  });

  it('resolves connectivity profile', async () => {
    const mockConn = { name: 'my-conn', hasTailscaleKey: true };
    getConnectivityProfile.mockResolvedValue(mockConn);

    const spec: AgentSpec = {
      name: 'test-agent',
      workstationType: 'general-purpose',
      connectivityProfile: 'my-conn',
    };

    const resolved = await resolveAgentSpec(spec, mockGlobalConfig);
    expect(resolved.connectivity).toEqual(mockConn);
  });
});
