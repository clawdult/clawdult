import { jest } from '@jest/globals';

const mockStartInstance = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockWaitForInstanceRunning = jest.fn<() => Promise<unknown>>().mockResolvedValue({
  state: 'running',
  publicIpAddress: '5.6.7.8',
});

jest.unstable_mockModule('../../services/ec2.js', () => ({
  startInstance: mockStartInstance,
  waitForInstanceRunning: mockWaitForInstanceRunning,
}));

const mockResolveInstance = jest.fn<() => Promise<unknown>>();
jest.unstable_mockModule('../utils/instance-resolver.js', () => ({
  resolveInstance: mockResolveInstance,
}));

jest.unstable_mockModule('../utils/require-aws.js', () => ({
  requireAwsCredentials: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('ora', () => ({
  default: () => ({
    start: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
    text: '',
  }),
}));

jest.unstable_mockModule('chalk', () => {
  const handler: ProxyHandler<object> = {
    get: () => new Proxy((s: string) => s, handler),
    apply: (_t: object, _this: unknown, args: string[]) => args[0],
  };
  return { default: new Proxy({}, handler) };
});

jest.unstable_mockModule('../utils/errors.js', () => ({
  CLIError: class CLIError extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'CLIError';
    }
  },
}));

const { startCommand } = await import('./start.js');

const testInstance = {
  name: 'test-agent',
  instanceId: 'i-1234567890',
  state: 'stopped' as const,
  region: 'us-east-1',
  instanceType: 't3.medium',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveInstance.mockResolvedValue(testInstance);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('start command', () => {
  it('starts a stopped instance', async () => {
    await startCommand.parseAsync(['test-agent'], { from: 'user' });

    expect(mockResolveInstance).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-agent', filterStates: ['stopped'] })
    );
    expect(mockStartInstance).toHaveBeenCalledWith('i-1234567890', 'us-east-1');
    expect(mockWaitForInstanceRunning).toHaveBeenCalledWith(
      'i-1234567890',
      'us-east-1',
      expect.objectContaining({ onProgress: expect.any(Function) })
    );
  });

  it('passes region option to resolveInstance', async () => {
    await startCommand.parseAsync(['test-agent', '-r', 'eu-west-1'], { from: 'user' });

    expect(mockResolveInstance).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'eu-west-1' })
    );
  });

  it('throws CLIError when startInstance fails', async () => {
    mockStartInstance.mockRejectedValue(new Error('instance limit exceeded'));

    await expect(startCommand.parseAsync(['test-agent'], { from: 'user' })).rejects.toThrow(
      'instance limit exceeded'
    );
  });

  it('works when instance has no public IP', async () => {
    mockStartInstance.mockResolvedValue(undefined);
    mockWaitForInstanceRunning.mockResolvedValue({
      state: 'running',
      privateIpAddress: '10.0.0.5',
    });

    await startCommand.parseAsync(['test-agent'], { from: 'user' });

    expect(mockStartInstance).toHaveBeenCalled();
  });
});
