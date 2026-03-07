import { jest } from '@jest/globals';

const mockStopInstance = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockWaitForInstanceStopped = jest.fn<() => Promise<unknown>>().mockResolvedValue({
  state: 'stopped',
});

jest.unstable_mockModule('../../services/ec2.js', () => ({
  stopInstance: mockStopInstance,
  waitForInstanceStopped: mockWaitForInstanceStopped,
}));

const mockConfirm = jest.fn<() => Promise<boolean>>();
jest.unstable_mockModule('@inquirer/prompts', () => ({
  confirm: mockConfirm,
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

const { stopCommand } = await import('./stop.js');

const testInstance = {
  name: 'test-agent',
  instanceId: 'i-1234567890',
  state: 'running' as const,
  region: 'us-east-1',
  instanceType: 't3.medium',
  publicIp: '1.2.3.4',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveInstance.mockResolvedValue(testInstance);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('stop command', () => {
  it('stops an instance after confirmation', async () => {
    mockConfirm.mockResolvedValue(true);

    await stopCommand.parseAsync(['test-agent'], { from: 'user' });

    expect(mockResolveInstance).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-agent', filterStates: ['running'] })
    );
    expect(mockStopInstance).toHaveBeenCalledWith('i-1234567890', 'us-east-1');
    expect(mockWaitForInstanceStopped).toHaveBeenCalledWith(
      'i-1234567890',
      'us-east-1',
      expect.objectContaining({ onProgress: expect.any(Function) })
    );
  });

  it('aborts when user declines confirmation', async () => {
    mockConfirm.mockResolvedValue(false);

    await stopCommand.parseAsync(['test-agent'], { from: 'user' });

    expect(mockStopInstance).not.toHaveBeenCalled();
  });

  it('skips confirmation with --force flag', async () => {
    await stopCommand.parseAsync(['test-agent', '--force'], { from: 'user' });

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockStopInstance).toHaveBeenCalledWith('i-1234567890', 'us-east-1');
  });

  it('passes region option to resolveInstance', async () => {
    mockConfirm.mockResolvedValue(true);

    await stopCommand.parseAsync(['test-agent', '-r', 'us-west-2'], { from: 'user' });

    expect(mockResolveInstance).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-west-2' })
    );
  });

  it('throws CLIError when stopInstance fails', async () => {
    mockConfirm.mockResolvedValue(true);
    mockStopInstance.mockRejectedValue(new Error('API failure'));

    await expect(stopCommand.parseAsync(['test-agent'], { from: 'user' })).rejects.toThrow(
      'API failure'
    );
  });
});
