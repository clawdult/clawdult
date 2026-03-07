import { jest } from '@jest/globals';

// --- Mocks ---

const mockSSMClientSend = jest.fn<(cmd: unknown) => Promise<unknown>>();

jest.unstable_mockModule('@aws-sdk/client-ssm', () => {
  class FakeSSMClient {
    send = mockSSMClientSend;
  }

  class ParameterAlreadyExists extends Error {
    name = 'ParameterAlreadyExists';
    constructor() {
      super('Parameter already exists');
    }
  }

  class ParameterNotFound extends Error {
    name = 'ParameterNotFound';
    constructor() {
      super('Parameter not found');
    }
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
  getSecret: jest.fn<(service: string, key: string) => Promise<string | null>>(),
  storeSecret: jest.fn<() => Promise<void>>(),
  deleteSecret: jest.fn<() => Promise<void>>(),
}));

jest.unstable_mockModule('./key-profiles.js', () => ({
  getProfileWithKeys: jest.fn<() => Promise<unknown>>(),
  KEY_NAME_MAP: {
    claude: 'anthropic-api-key',
    'claude-setup-token': 'claude-setup-token',
    openai: 'openai-api-key',
    grok: 'xai-api-key',
    gemini: 'google-api-key',
  },
}));

jest.unstable_mockModule('./connectivity-profiles.js', () => ({
  getProfileWithSecrets: jest.fn<() => Promise<unknown>>(),
}));

jest.unstable_mockModule('./github-agent.js', () => ({
  getAgentToken: jest.fn<() => Promise<string | null>>(),
}));

const ssmModule = await import('./ssm.js');
const { getSecret } = (await import('./secrets.js')) as unknown as {
  getSecret: jest.MockedFunction<(service: string, key: string) => Promise<string | null>>;
};
const { getProfileWithKeys } = (await import('./key-profiles.js')) as unknown as {
  getProfileWithKeys: jest.MockedFunction<(name: string) => Promise<unknown>>;
};
const { getAgentToken } = (await import('./github-agent.js')) as unknown as {
  getAgentToken: jest.MockedFunction<(username: string) => Promise<string | null>>;
};

// --- Tests ---

describe('KEY_NAME_MAP', () => {
  it('maps wizard key names to SSM parameter names', () => {
    expect(ssmModule.KEY_NAME_MAP).toEqual({
      claude: 'anthropic-api-key',
      openai: 'openai-api-key',
      grok: 'xai-api-key',
      gemini: 'google-api-key',
    });
  });
});

describe('getTailscaleIP', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('constructs correct SSM parameter path', async () => {
    mockSSMClientSend.mockResolvedValueOnce({
      Parameter: { Value: '100.64.1.1' },
    });

    const ip = await ssmModule.getTailscaleIP('my-agent', 'us-east-1');

    expect(ip).toBe('100.64.1.1');
    const cmd = mockSSMClientSend.mock.calls[0][0] as { input: { Name: string } };
    expect(cmd.input.Name).toBe('/clawdult/my-agent/tailscale-ip');
  });

  it('returns null when parameter not found', async () => {
    const { ParameterNotFound } = await import('@aws-sdk/client-ssm');
    mockSSMClientSend.mockRejectedValueOnce(
      new (ParameterNotFound as unknown as new () => Error)()
    );

    const ip = await ssmModule.getTailscaleIP('missing-agent', 'us-east-1');
    expect(ip).toBeNull();
  });

  it('returns null when Parameter.Value is undefined', async () => {
    mockSSMClientSend.mockResolvedValueOnce({ Parameter: {} });
    const ip = await ssmModule.getTailscaleIP('empty-agent', 'us-east-1');
    expect(ip).toBeNull();
  });

  it('propagates non-ParameterNotFound errors', async () => {
    const error = new Error('Forbidden');
    error.name = 'ForbiddenException';
    mockSSMClientSend.mockRejectedValueOnce(error);

    await expect(ssmModule.getTailscaleIP('agent', 'us-east-1')).rejects.toThrow('Forbidden');
  });
});

describe('pushSecretsToSSM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSSMClientSend.mockResolvedValue({});
  });

  it('pushes available keys with correct SSM paths', async () => {
    getSecret.mockImplementation(async (_service: string, key: string) => {
      if (key === 'claude') return 'sk-ant-123';
      if (key === 'openai') return 'sk-openai-456';
      return null;
    });

    const result = await ssmModule.pushSecretsToSSM('test-agent', 'us-east-1');

    expect(result.pushed).toContain('claude');
    expect(result.pushed).toContain('openai');
    expect(result.skipped).toContain('grok');
    expect(result.skipped).toContain('gemini');

    // Verify SSM paths used
    const putCalls = mockSSMClientSend.mock.calls.map(
      (c) => (c[0] as { input: { Name: string } }).input.Name
    );
    expect(putCalls).toContain('/clawdult/test-agent/anthropic-api-key');
    expect(putCalls).toContain('/clawdult/test-agent/openai-api-key');
  });

  it('skips keys that are not stored', async () => {
    getSecret.mockResolvedValue(null);

    const result = await ssmModule.pushSecretsToSSM('empty-agent', 'us-east-1');

    expect(result.pushed).toEqual([]);
    expect(result.skipped).toEqual(['claude', 'openai', 'grok', 'gemini']);
    expect(mockSSMClientSend).not.toHaveBeenCalled();
  });

  it('throws with partial failure details', async () => {
    getSecret.mockImplementation(async (_service: string, key: string) => {
      if (key === 'claude') return 'sk-ant-123';
      if (key === 'openai') return 'sk-openai-456';
      return null;
    });

    mockSSMClientSend
      .mockResolvedValueOnce({}) // claude succeeds
      .mockRejectedValueOnce(new Error('SSM throttled')); // openai fails

    await expect(ssmModule.pushSecretsToSSM('agent', 'us-east-1')).rejects.toThrow(
      /Partial SSM push failure.*Succeeded:.*claude.*Failed:.*openai.*SSM throttled/
    );
  });
});

describe('pushKeyProfileToSSM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSSMClientSend.mockResolvedValue({});
  });

  it('throws when profile not found', async () => {
    getProfileWithKeys.mockResolvedValue(null);

    await expect(ssmModule.pushKeyProfileToSSM('agent', 'us-east-1', 'missing')).rejects.toThrow(
      "Key profile 'missing' not found"
    );
  });

  it('pushes profile keys with correct SSM paths', async () => {
    getProfileWithKeys.mockResolvedValue({
      name: 'my-keys',
      claudeKey: 'sk-ant-key',
      openaiKey: 'sk-openai-key',
      grokKey: undefined,
      geminiKey: undefined,
      claudeSetupToken: undefined,
    });

    const result = await ssmModule.pushKeyProfileToSSM('test-agent', 'us-east-1', 'my-keys');

    expect(result.pushed).toContain('claude');
    expect(result.pushed).toContain('openai');
    expect(result.skipped).toContain('grok');
    expect(result.skipped).toContain('gemini');
    expect(result.skipped).toContain('claude-setup-token');
  });
});

describe('pushGitHubCredentialsToSSM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSSMClientSend.mockResolvedValue({});
  });

  it('throws when no token found for GitHub account', async () => {
    getAgentToken.mockResolvedValue(null);

    await expect(
      ssmModule.pushGitHubCredentialsToSSM('agent', 'us-east-1', {
        username: 'bot-user',
        email: 'bot@example.com',
        createdAt: new Date().toISOString(),
      })
    ).rejects.toThrow('No stored token found for GitHub account: bot-user');
  });

  it('pushes token, username, and email to correct SSM paths', async () => {
    getAgentToken.mockResolvedValue('ghp_token123');

    await ssmModule.pushGitHubCredentialsToSSM('my-agent', 'us-east-1', {
      username: 'bot-user',
      email: 'bot@example.com',
      createdAt: new Date().toISOString(),
    });

    const putCalls = mockSSMClientSend.mock.calls.map(
      (c) => (c[0] as { input: { Name: string; Value: string; Type: string } }).input
    );

    expect(putCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Name: '/clawdult/my-agent/github-token',
          Value: 'ghp_token123',
          Type: 'SecureString',
        }),
        expect.objectContaining({
          Name: '/clawdult/my-agent/github-username',
          Value: 'bot-user',
          Type: 'String',
        }),
        expect.objectContaining({
          Name: '/clawdult/my-agent/github-email',
          Value: 'bot@example.com',
          Type: 'String',
        }),
      ])
    );
  });
});

describe('getGatewayURL', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('constructs correct SSM parameter path', async () => {
    mockSSMClientSend.mockResolvedValueOnce({
      Parameter: { Value: 'https://clawdult-agent.ts.net' },
    });

    const url = await ssmModule.getGatewayURL('my-agent', 'us-east-1');

    expect(url).toBe('https://clawdult-agent.ts.net');
    const cmd = mockSSMClientSend.mock.calls[0][0] as { input: { Name: string } };
    expect(cmd.input.Name).toBe('/clawdult/my-agent/gateway-url');
  });

  it('returns null when parameter not found', async () => {
    const { ParameterNotFound } = await import('@aws-sdk/client-ssm');
    mockSSMClientSend.mockRejectedValueOnce(
      new (ParameterNotFound as unknown as new () => Error)()
    );

    const url = await ssmModule.getGatewayURL('missing', 'us-east-1');
    expect(url).toBeNull();
  });
});

describe('pushMessagingCredentialsToSSM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSSMClientSend.mockResolvedValue({});
  });

  it('pushes only provided credentials', async () => {
    const result = await ssmModule.pushMessagingCredentialsToSSM('agent', 'us-east-1', {
      telegramBotToken: 'tg-token',
      discordOAuth: 'dc-token',
    });

    expect(result.pushed).toEqual(['telegramBotToken', 'discordOAuth']);
    expect(result.skipped).toContain('slackOAuth');
    expect(result.skipped).toContain('googlechatToken');

    const putCalls = mockSSMClientSend.mock.calls.map(
      (c) => (c[0] as { input: { Name: string } }).input.Name
    );
    expect(putCalls).toContain('/clawdult/agent/telegram-bot-token');
    expect(putCalls).toContain('/clawdult/agent/discord-oauth');
  });

  it('skips all when no credentials provided', async () => {
    const result = await ssmModule.pushMessagingCredentialsToSSM('agent', 'us-east-1', {});

    expect(result.pushed).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(mockSSMClientSend).not.toHaveBeenCalled();
  });
});

describe('pushOpenClawConfigToSSM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSSMClientSend.mockResolvedValue({});
  });

  it('pushes config as JSON SecureString to correct path', async () => {
    const config = {
      model: 'claude-3-opus',
      channels: { telegram: true, discord: true },
      gateway: { mode: 'tailscale-serve' as const },
    };

    await ssmModule.pushOpenClawConfigToSSM('my-agent', 'us-east-1', config);

    const putCall = mockSSMClientSend.mock.calls[0][0] as {
      input: { Name: string; Value: string; Type: string };
    };
    expect(putCall.input.Name).toBe('/clawdult/my-agent/openclaw-config');
    expect(putCall.input.Type).toBe('SecureString');
    expect(JSON.parse(putCall.input.Value)).toEqual(config);
  });
});

describe('pushOpenClawTokenToSSM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSSMClientSend.mockResolvedValue({});
  });

  it('generates a 64-char hex token and pushes to correct path', async () => {
    const token = await ssmModule.pushOpenClawTokenToSSM('my-agent', 'us-east-1');

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const putCall = mockSSMClientSend.mock.calls[0][0] as {
      input: { Name: string; Value: string; Type: string };
    };
    expect(putCall.input.Name).toBe('/clawdult/my-agent/openclaw-token');
    expect(putCall.input.Type).toBe('SecureString');
    expect(putCall.input.Value).toBe(token);
  });
});

describe('copySSMParameters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('copies params from source to dest with correct path rewriting', async () => {
    mockSSMClientSend
      .mockResolvedValueOnce({
        Parameters: [
          {
            Name: '/clawdult/source-agent/anthropic-api-key',
            Value: 'sk-123',
            Type: 'SecureString',
          },
          { Name: '/clawdult/source-agent/github-username', Value: 'bot', Type: 'String' },
        ],
      })
      .mockResolvedValue({}); // putParameter calls

    const result = await ssmModule.copySSMParameters('source-agent', 'dest-agent', 'us-east-1');

    expect(result.copied).toEqual(['anthropic-api-key', 'github-username']);
    expect(result.failed).toEqual([]);

    // First call is GetParametersByPath; subsequent calls are PutParameter
    const getCall = mockSSMClientSend.mock.calls[0][0] as { input: Record<string, unknown> };
    expect(getCall.input.Path).toBe('/clawdult/source-agent/');
    expect(getCall.input.WithDecryption).toBe(true);

    // Check dest paths
    const putCalls = mockSSMClientSend.mock.calls
      .slice(1)
      .map((c) => (c[0] as { input: { Name: string; Type: string } }).input);
    expect(putCalls[0].Name).toBe('/clawdult/dest-agent/anthropic-api-key');
    expect(putCalls[1].Name).toBe('/clawdult/dest-agent/github-username');
  });

  it('handles pagination with NextToken', async () => {
    mockSSMClientSend
      .mockResolvedValueOnce({
        Parameters: [{ Name: '/clawdult/src/key-a', Value: 'val-a', Type: 'String' }],
        NextToken: 'page2',
      })
      .mockResolvedValueOnce({}) // putParameter for key-a
      .mockResolvedValueOnce({
        Parameters: [{ Name: '/clawdult/src/key-b', Value: 'val-b', Type: 'String' }],
      })
      .mockResolvedValueOnce({}); // putParameter for key-b

    const result = await ssmModule.copySSMParameters('src', 'dst', 'us-east-1');

    expect(result.copied).toEqual(['key-a', 'key-b']);
    expect(result.failed).toEqual([]);

    // Second GetParametersByPath should include NextToken
    const secondGetCall = mockSSMClientSend.mock.calls[2][0] as { input: Record<string, unknown> };
    expect(secondGetCall.input.NextToken).toBe('page2');
  });

  it('reports partial failures', async () => {
    mockSSMClientSend
      .mockResolvedValueOnce({
        Parameters: [
          { Name: '/clawdult/src/key-ok', Value: 'ok', Type: 'String' },
          { Name: '/clawdult/src/key-fail', Value: 'fail', Type: 'SecureString' },
        ],
      })
      .mockResolvedValueOnce({}) // key-ok succeeds
      .mockRejectedValueOnce(new Error('Throttled')); // key-fail fails

    const result = await ssmModule.copySSMParameters('src', 'dst', 'us-east-1');

    expect(result.copied).toEqual(['key-ok']);
    expect(result.failed).toEqual([expect.stringContaining('key-fail')]);
    expect(result.failed[0]).toContain('Throttled');
  });

  it('returns empty copied/failed for empty source', async () => {
    mockSSMClientSend.mockResolvedValueOnce({ Parameters: [] });

    const result = await ssmModule.copySSMParameters('empty', 'dst', 'us-east-1');

    expect(result.copied).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('returns empty when no Parameters key in response', async () => {
    mockSSMClientSend.mockResolvedValueOnce({});

    const result = await ssmModule.copySSMParameters('empty', 'dst', 'us-east-1');

    expect(result.copied).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('preserves param Type (String vs SecureString)', async () => {
    mockSSMClientSend
      .mockResolvedValueOnce({
        Parameters: [
          { Name: '/clawdult/src/plain', Value: 'val', Type: 'String' },
          { Name: '/clawdult/src/secret', Value: 'hidden', Type: 'SecureString' },
        ],
      })
      .mockResolvedValue({});

    await ssmModule.copySSMParameters('src', 'dst', 'us-east-1');

    const putCalls = mockSSMClientSend.mock.calls
      .slice(1)
      .map((c) => (c[0] as { input: { Name: string; Type: string } }).input);
    expect(putCalls[0].Type).toBe('String');
    expect(putCalls[1].Type).toBe('SecureString');
  });
});

describe('pushSageMakerRoleArnToSSM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSSMClientSend.mockResolvedValue({});
  });

  it('pushes role ARN to correct path', async () => {
    await ssmModule.pushSageMakerRoleArnToSSM(
      'my-agent',
      'us-east-1',
      'arn:aws:iam::123:role/sm-role'
    );

    const putCall = mockSSMClientSend.mock.calls[0][0] as {
      input: { Name: string; Value: string };
    };
    expect(putCall.input.Name).toBe('/clawdult/my-agent/sagemaker-role-arn');
    expect(putCall.input.Value).toBe('arn:aws:iam::123:role/sm-role');
  });

  it('uses Type String', async () => {
    await ssmModule.pushSageMakerRoleArnToSSM('agent', 'us-east-1', 'arn:role');

    const putCall = mockSSMClientSend.mock.calls[0][0] as {
      input: { Type: string };
    };
    expect(putCall.input.Type).toBe('String');
  });

  it('includes clawdult tags', async () => {
    await ssmModule.pushSageMakerRoleArnToSSM('my-agent', 'us-east-1', 'arn:role');

    const putCall = mockSSMClientSend.mock.calls[0][0] as {
      input: { Tags: Array<{ Key: string; Value: string }> };
    };
    expect(putCall.input.Tags).toEqual([
      { Key: 'clawdult:agent', Value: 'my-agent' },
      { Key: 'clawdult:managed', Value: 'true' },
    ]);
  });
});

describe('getSageMakerRoleArn', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns role ARN from correct path', async () => {
    mockSSMClientSend.mockResolvedValueOnce({
      Parameter: { Value: 'arn:aws:iam::123:role/sm-role' },
    });

    const arn = await ssmModule.getSageMakerRoleArn('my-agent', 'us-east-1');

    expect(arn).toBe('arn:aws:iam::123:role/sm-role');
    const cmd = mockSSMClientSend.mock.calls[0][0] as { input: { Name: string } };
    expect(cmd.input.Name).toBe('/clawdult/my-agent/sagemaker-role-arn');
  });

  it('returns null on ParameterNotFound', async () => {
    const { ParameterNotFound } = await import('@aws-sdk/client-ssm');
    mockSSMClientSend.mockRejectedValueOnce(
      new (ParameterNotFound as unknown as new () => Error)()
    );

    const arn = await ssmModule.getSageMakerRoleArn('missing', 'us-east-1');
    expect(arn).toBeNull();
  });

  it('propagates other errors', async () => {
    const error = new Error('Access denied');
    error.name = 'AccessDeniedException';
    mockSSMClientSend.mockRejectedValueOnce(error);

    await expect(ssmModule.getSageMakerRoleArn('agent', 'us-east-1')).rejects.toThrow(
      'Access denied'
    );
  });
});

describe('pushWorkstationTypeToSSM', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSSMClientSend.mockResolvedValue({});
  });

  it('pushes JSON-stringified workstation type to correct path', async () => {
    const wsType = {
      name: 'gpu-large',
      capabilities: ['gpu', 'docker'],
      tools: { claudeCode: true, playwright: false },
    };

    await ssmModule.pushWorkstationTypeToSSM('my-agent', 'us-east-1', wsType);

    const putCall = mockSSMClientSend.mock.calls[0][0] as {
      input: { Name: string; Value: string };
    };
    expect(putCall.input.Name).toBe('/clawdult/my-agent/workstation-type');
    expect(JSON.parse(putCall.input.Value)).toEqual(wsType);
  });

  it('uses Type String', async () => {
    await ssmModule.pushWorkstationTypeToSSM('agent', 'us-east-1', {
      name: 'basic',
      capabilities: [],
      tools: {},
    });

    const putCall = mockSSMClientSend.mock.calls[0][0] as {
      input: { Type: string };
    };
    expect(putCall.input.Type).toBe('String');
  });
});
