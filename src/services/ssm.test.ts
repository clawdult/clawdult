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
