import { jest } from '@jest/globals';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// --- Mocks ---

const mockSSMClientSend = jest.fn<(cmd: unknown) => Promise<unknown>>();

jest.unstable_mockModule('@aws-sdk/client-ssm', () => {
  class FakeSSMClient {
    send = mockSSMClientSend;
  }

  class ParameterAlreadyExists extends Error {
    name = 'ParameterAlreadyExists';
  }

  class ParameterNotFound extends Error {
    name = 'ParameterNotFound';
  }

  const cmd = (name: string) =>
    class {
      static _name = name;
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    };

  return {
    SSMClient: FakeSSMClient,
    PutParameterCommand: cmd('PutParameterCommand'),
    GetParameterCommand: cmd('GetParameterCommand'),
    GetParametersByPathCommand: cmd('GetParametersByPathCommand'),
    ParameterAlreadyExists,
    ParameterNotFound,
  };
});

jest.unstable_mockModule('./aws-client.js', () => ({
  getAWSClientConfig: jest
    .fn<() => Promise<{ region: string }>>()
    .mockResolvedValue({ region: 'us-east-1' }),
}));

jest.unstable_mockModule('./aws-retry.js', () => ({
  retryWithBackoff: jest
    .fn<(fn: () => Promise<unknown>) => Promise<unknown>>()
    .mockImplementation((fn) => fn()),
}));

jest.unstable_mockModule('./secrets.js', () => ({
  getSecret: jest.fn(),
  storeSecret: jest.fn(),
  deleteSecret: jest.fn(),
}));

jest.unstable_mockModule('./key-profiles.js', () => ({
  getProfileWithKeys: jest.fn(),
  KEY_NAME_MAP: {
    claude: 'anthropic-api-key',
    'claude-setup-token': 'claude-setup-token',
    openai: 'openai-api-key',
    grok: 'xai-api-key',
    gemini: 'google-api-key',
  },
}));

jest.unstable_mockModule('./connectivity-profiles.js', () => ({
  getProfileWithSecrets: jest.fn(),
}));

jest.unstable_mockModule('./github-agent.js', () => ({
  getAgentToken: jest.fn(),
}));

const { pushAgentInstructionsToSSM, pushWorkstationTypeToSSM } = await import('./ssm.js');

describe('pushAgentInstructionsToSSM', () => {
  let tmpDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSSMClientSend.mockResolvedValue({});
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'ssm-instr-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('pushes inline instructions as JSON to correct SSM path', async () => {
    await pushAgentInstructionsToSSM('my-agent', 'us-east-1', {
      purpose: 'Test agent',
      instructions: 'You are a test agent.',
      repos: [{ url: 'org/repo' }],
      cron: [],
    });

    const putCall = mockSSMClientSend.mock.calls[0][0] as {
      input: { Name: string; Value: string; Type: string };
    };
    expect(putCall.input.Name).toBe('/clawdult/my-agent/agent-instructions');
    expect(putCall.input.Type).toBe('String');

    const parsed = JSON.parse(putCall.input.Value);
    expect(parsed.purpose).toBe('Test agent');
    expect(parsed.instructions).toBe('You are a test agent.');
    expect(parsed.repos).toHaveLength(1);
  });

  it('resolves file: references to inline content', async () => {
    const mdPath = path.join(tmpDir, 'instructions.md');
    await writeFile(mdPath, '# Agent Instructions\nDo good work.');

    await pushAgentInstructionsToSSM('my-agent', 'us-east-1', {
      purpose: 'File test',
      instructions: `file:${mdPath}`,
      repos: [],
      cron: [],
    });

    const putCall = mockSSMClientSend.mock.calls[0][0] as {
      input: { Value: string };
    };
    const parsed = JSON.parse(putCall.input.Value);
    expect(parsed.instructions).toBe('# Agent Instructions\nDo good work.');
    expect(parsed.instructions).not.toContain('file:');
  });

  it('pushes instructions without purpose or file ref', async () => {
    await pushAgentInstructionsToSSM('my-agent', 'us-east-1', {
      repos: [{ url: 'org/repo1' }, { url: 'org/repo2', branch: 'dev' }],
      cron: [{ schedule: '0 0 * * *', command: 'daily-check' }],
    });

    const putCall = mockSSMClientSend.mock.calls[0][0] as {
      input: { Value: string };
    };
    const parsed = JSON.parse(putCall.input.Value);
    expect(parsed.repos).toHaveLength(2);
    expect(parsed.cron).toHaveLength(1);
    expect(parsed.cron[0].schedule).toBe('0 0 * * *');
  });

  it('throws when file: reference points to missing file', async () => {
    await expect(
      pushAgentInstructionsToSSM('my-agent', 'us-east-1', {
        instructions: 'file:/nonexistent/path.md',
        repos: [],
        cron: [],
      })
    ).rejects.toThrow();
  });
});

describe('pushWorkstationTypeToSSM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSSMClientSend.mockResolvedValue({});
  });

  it('pushes workstation type as JSON String', async () => {
    await pushWorkstationTypeToSSM('my-agent', 'us-east-1', {
      name: 'general-purpose',
      capabilities: [],
      tools: {
        claudeCode: true,
        codex: true,
        grok: false,
        gemini: false,
        playwright: true,
        docker: true,
      },
    });

    const putCall = mockSSMClientSend.mock.calls[0][0] as {
      input: { Name: string; Value: string; Type: string };
    };
    expect(putCall.input.Name).toBe('/clawdult/my-agent/workstation-type');
    expect(putCall.input.Type).toBe('String');
    const parsed = JSON.parse(putCall.input.Value);
    expect(parsed.name).toBe('general-purpose');
    expect(parsed.capabilities).toEqual([]);
  });
});
