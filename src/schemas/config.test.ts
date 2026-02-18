import {
  InstanceTypeSchema,
  RegionSchema,
  WorkstationConfigSchema,
  GlobalConfigSchema,
  ToolsConfigSchema,
  GitHubAgentAccountSchema,
} from './config.js';

describe('InstanceTypeSchema', () => {
  it('accepts valid instance types', () => {
    expect(InstanceTypeSchema.parse('t3.micro')).toBe('t3.micro');
    expect(InstanceTypeSchema.parse('t3.medium')).toBe('t3.medium');
    expect(InstanceTypeSchema.parse('m6i.xlarge')).toBe('m6i.xlarge');
  });

  it('rejects invalid instance types', () => {
    expect(() => InstanceTypeSchema.parse('t2.micro')).toThrow();
    expect(() => InstanceTypeSchema.parse('invalid')).toThrow();
    expect(() => InstanceTypeSchema.parse('')).toThrow();
  });
});

describe('RegionSchema', () => {
  it('accepts valid regions', () => {
    expect(RegionSchema.parse('us-east-1')).toBe('us-east-1');
    expect(RegionSchema.parse('eu-west-1')).toBe('eu-west-1');
    expect(RegionSchema.parse('ap-southeast-2')).toBe('ap-southeast-2');
  });

  it('rejects invalid regions', () => {
    expect(() => RegionSchema.parse('us-north-1')).toThrow();
    expect(() => RegionSchema.parse('invalid')).toThrow();
    expect(() => RegionSchema.parse('')).toThrow();
  });
});

describe('WorkstationConfigSchema', () => {
  it('accepts valid workstation config with minimal fields', () => {
    const result = WorkstationConfigSchema.parse({ name: 'my-agent' });
    expect(result.name).toBe('my-agent');
  });

  it('applies default values', () => {
    const result = WorkstationConfigSchema.parse({ name: 'my-agent' });
    expect(result.instanceType).toBe('t3.medium');
    expect(result.region).toBe('us-east-1');
    expect(result.volumeSize).toBe(50);
  });

  it('accepts valid workstation names', () => {
    expect(() => WorkstationConfigSchema.parse({ name: 'agent1' })).not.toThrow();
    expect(() => WorkstationConfigSchema.parse({ name: 'my-agent-1' })).not.toThrow();
    expect(() => WorkstationConfigSchema.parse({ name: 'a1' })).not.toThrow();
  });

  it('rejects names starting with uppercase', () => {
    expect(() => WorkstationConfigSchema.parse({ name: 'MyAgent' })).toThrow();
  });

  it('rejects names starting with a number', () => {
    expect(() => WorkstationConfigSchema.parse({ name: '1agent' })).toThrow();
  });

  it('rejects names ending with a hyphen', () => {
    expect(() => WorkstationConfigSchema.parse({ name: 'agent-' })).toThrow();
  });

  it('rejects names with invalid characters', () => {
    expect(() => WorkstationConfigSchema.parse({ name: 'my_agent' })).toThrow();
    expect(() => WorkstationConfigSchema.parse({ name: 'my.agent' })).toThrow();
    expect(() => WorkstationConfigSchema.parse({ name: 'my agent' })).toThrow();
  });

  it('rejects empty names', () => {
    expect(() => WorkstationConfigSchema.parse({ name: '' })).toThrow();
  });

  it('rejects single character names', () => {
    // Name must match regex /^[a-z][a-z0-9-]*[a-z0-9]$/ which requires at least 2 chars
    expect(() => WorkstationConfigSchema.parse({ name: 'a' })).toThrow();
  });

  it('accepts optional owner field', () => {
    const result = WorkstationConfigSchema.parse({
      name: 'my-agent',
      owner: 'user@example.com',
    });
    expect(result.owner).toBe('user@example.com');
  });

  it('accepts custom volume size within range', () => {
    const result = WorkstationConfigSchema.parse({
      name: 'my-agent',
      volumeSize: 100,
    });
    expect(result.volumeSize).toBe(100);
  });

  it('rejects volume size below minimum', () => {
    expect(() => WorkstationConfigSchema.parse({ name: 'my-agent', volumeSize: 10 })).toThrow();
  });

  it('rejects volume size above maximum', () => {
    expect(() => WorkstationConfigSchema.parse({ name: 'my-agent', volumeSize: 600 })).toThrow();
  });
});

describe('GlobalConfigSchema', () => {
  it('applies all default values for empty config', () => {
    const result = GlobalConfigSchema.parse({});
    expect(result.defaultRegion).toBe('us-east-1');
    expect(result.defaultInstanceType).toBe('t3.medium');
    expect(result.defaultVolumeSize).toBe(50);
    expect(result.logsDirectory).toBe('~/.clawdult/logs');
    expect(result.githubAgentAccounts).toEqual([]);
  });

  it('accepts optional fields', () => {
    const result = GlobalConfigSchema.parse({
      awsProfile: 'my-profile',
      sshKeyPath: '~/.ssh/id_rsa',
    });
    expect(result.awsProfile).toBe('my-profile');
    expect(result.sshKeyPath).toBe('~/.ssh/id_rsa');
  });
});

describe('GitHubAgentAccountSchema', () => {
  it('accepts valid GitHub agent account', () => {
    const result = GitHubAgentAccountSchema.parse({
      username: 'agent-bot',
      email: 'agent@example.com',
      createdAt: '2024-01-15T10:30:00Z',
    });
    expect(result.username).toBe('agent-bot');
    expect(result.email).toBe('agent@example.com');
  });

  it('accepts optional description', () => {
    const result = GitHubAgentAccountSchema.parse({
      username: 'agent-bot',
      email: 'agent@example.com',
      createdAt: '2024-01-15T10:30:00Z',
      description: 'My AI coding assistant',
    });
    expect(result.description).toBe('My AI coding assistant');
  });

  it('rejects missing required fields', () => {
    expect(() => GitHubAgentAccountSchema.parse({ username: 'agent-bot' })).toThrow();
  });

  it('rejects invalid email', () => {
    expect(() =>
      GitHubAgentAccountSchema.parse({
        username: 'agent-bot',
        email: 'not-an-email',
        createdAt: '2024-01-15T10:30:00Z',
      })
    ).toThrow();
  });

  it('rejects invalid datetime format', () => {
    expect(() =>
      GitHubAgentAccountSchema.parse({
        username: 'agent-bot',
        email: 'agent@example.com',
        createdAt: '2024-01-15',
      })
    ).toThrow();
  });
});

describe('ToolsConfigSchema', () => {
  it('applies default values', () => {
    const result = ToolsConfigSchema.parse({});
    expect(result.claudeCode).toBe(true);
    expect(result.codex).toBe(true);
    expect(result.grok).toBe(false);
    expect(result.gemini).toBe(false);
    expect(result.playwright).toBe(true);
    expect(result.docker).toBe(true);
  });

  it('accepts custom tool configuration', () => {
    const result = ToolsConfigSchema.parse({
      claudeCode: false,
      grok: true,
    });
    expect(result.claudeCode).toBe(false);
    expect(result.grok).toBe(true);
    expect(result.codex).toBe(true); // default
  });
});
