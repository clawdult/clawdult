import {
  RepoSchema,
  AgentInstructionsSchema,
  AgentSpecSchema,
  WorkstationTypeSchema,
  CapabilityModuleSchema,
} from './config.js';

describe('RepoSchema', () => {
  it('accepts minimal repo (url only)', () => {
    const result = RepoSchema.parse({ url: 'owner/repo' });
    expect(result.url).toBe('owner/repo');
    expect(result.branch).toBeUndefined();
    expect(result.path).toBeUndefined();
  });

  it('accepts full repo with branch and path', () => {
    const result = RepoSchema.parse({
      url: 'https://github.com/org/repo.git',
      branch: 'main',
      path: 'my-project',
    });
    expect(result.url).toBe('https://github.com/org/repo.git');
    expect(result.branch).toBe('main');
    expect(result.path).toBe('my-project');
  });

  it('rejects missing url', () => {
    expect(() => RepoSchema.parse({})).toThrow();
  });
});

describe('AgentInstructionsSchema', () => {
  it('accepts empty object with defaults', () => {
    const result = AgentInstructionsSchema.parse({});
    expect(result.repos).toEqual([]);
    expect(result.cron).toEqual([]);
    expect(result.purpose).toBeUndefined();
    expect(result.instructions).toBeUndefined();
  });

  it('accepts full instructions', () => {
    const result = AgentInstructionsSchema.parse({
      purpose: 'Customer support agent',
      instructions: 'You are a helpful support bot.',
      repos: [{ url: 'org/support-tools', branch: 'main' }],
      cron: [{ schedule: '0 * * * *', command: 'check-tickets' }],
    });
    expect(result.purpose).toBe('Customer support agent');
    expect(result.instructions).toBe('You are a helpful support bot.');
    expect(result.repos).toHaveLength(1);
    expect(result.cron).toHaveLength(1);
  });

  it('accepts file: reference in instructions', () => {
    const result = AgentInstructionsSchema.parse({
      instructions: 'file:./agents/support.md',
    });
    expect(result.instructions).toBe('file:./agents/support.md');
  });

  it('accepts multiple repos', () => {
    const result = AgentInstructionsSchema.parse({
      repos: [{ url: 'org/repo1' }, { url: 'org/repo2', branch: 'develop', path: 'custom-dir' }],
    });
    expect(result.repos).toHaveLength(2);
  });

  it('cron requires schedule and command', () => {
    expect(() =>
      AgentInstructionsSchema.parse({
        cron: [{ schedule: '0 * * * *' }],
      })
    ).toThrow();
  });
});

describe('AgentSpecSchema', () => {
  it('accepts minimal spec', () => {
    const result = AgentSpecSchema.parse({
      name: 'my-agent',
      workstationType: 'general-purpose',
    });
    expect(result.name).toBe('my-agent');
    expect(result.workstationType).toBe('general-purpose');
  });

  it('accepts fully populated spec', () => {
    const result = AgentSpecSchema.parse({
      name: 'support-bot',
      workstationType: 'customer-service',
      keyProfile: 'prod-keys',
      connectivityProfile: 'slack-prod',
      budgetProfile: 'low-budget',
      github: 'bot-account',
      instanceType: 't3.medium',
      region: 'us-west-2',
      volumeSize: 100,
      instructions: {
        purpose: 'Handle support tickets',
        repos: [{ url: 'org/support-tools' }],
      },
      tags: { team: 'support', env: 'production' },
    });
    expect(result.keyProfile).toBe('prod-keys');
    expect(result.instructions?.purpose).toBe('Handle support tickets');
    expect(result.tags?.team).toBe('support');
  });

  it('rejects invalid name format', () => {
    expect(() =>
      AgentSpecSchema.parse({ name: 'MyAgent', workstationType: 'general-purpose' })
    ).toThrow();
    expect(() =>
      AgentSpecSchema.parse({ name: 'agent-', workstationType: 'general-purpose' })
    ).toThrow();
    expect(() =>
      AgentSpecSchema.parse({ name: '1agent', workstationType: 'general-purpose' })
    ).toThrow();
  });

  it('rejects invalid instance type', () => {
    expect(() =>
      AgentSpecSchema.parse({
        name: 'my-agent',
        workstationType: 'general-purpose',
        instanceType: 'c5.xlarge',
      })
    ).toThrow();
  });

  it('rejects invalid region', () => {
    expect(() =>
      AgentSpecSchema.parse({
        name: 'my-agent',
        workstationType: 'general-purpose',
        region: 'us-north-1',
      })
    ).toThrow();
  });

  it('rejects volume size out of range', () => {
    expect(() =>
      AgentSpecSchema.parse({
        name: 'my-agent',
        workstationType: 'general-purpose',
        volumeSize: 5,
      })
    ).toThrow();
    expect(() =>
      AgentSpecSchema.parse({
        name: 'my-agent',
        workstationType: 'general-purpose',
        volumeSize: 1000,
      })
    ).toThrow();
  });

  it('rejects missing workstationType', () => {
    expect(() => AgentSpecSchema.parse({ name: 'my-agent' })).toThrow();
  });
});

describe('WorkstationTypeSchema', () => {
  it('accepts type with defaults', () => {
    const result = WorkstationTypeSchema.parse({
      name: 'custom-type',
      description: 'A custom type',
    });
    expect(result.capabilities).toEqual([]);
    expect(result.tools.claudeCode).toBe(true);
    expect(result.tools.docker).toBe(true);
  });

  it('accepts type with capabilities', () => {
    const result = WorkstationTypeSchema.parse({
      name: 'ml-type',
      description: 'ML workstation',
      capabilities: ['sagemaker'],
    });
    expect(result.capabilities).toContain('sagemaker');
  });

  it('rejects invalid capability', () => {
    expect(() =>
      WorkstationTypeSchema.parse({
        name: 'bad-type',
        description: 'test',
        capabilities: ['invalid-cap'],
      })
    ).toThrow();
  });
});

describe('CapabilityModuleSchema', () => {
  it('accepts sagemaker', () => {
    expect(CapabilityModuleSchema.parse('sagemaker')).toBe('sagemaker');
  });

  it('rejects unknown capabilities', () => {
    expect(() => CapabilityModuleSchema.parse('kubernetes')).toThrow();
  });
});
