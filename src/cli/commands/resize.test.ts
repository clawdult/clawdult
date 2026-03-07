import { jest } from '@jest/globals';

const mockStopInstance = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockWaitForInstanceStopped = jest.fn<() => Promise<unknown>>().mockResolvedValue({
  state: 'stopped',
});
const mockModifyInstanceType = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockStartInstance = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockWaitForInstanceRunning = jest.fn<() => Promise<unknown>>().mockResolvedValue({
  state: 'running',
  publicIpAddress: '5.6.7.8',
});

jest.unstable_mockModule('../../services/ec2.js', () => ({
  stopInstance: mockStopInstance,
  waitForInstanceStopped: mockWaitForInstanceStopped,
  modifyInstanceType: mockModifyInstanceType,
  startInstance: mockStartInstance,
  waitForInstanceRunning: mockWaitForInstanceRunning,
}));

const mockSelect = jest.fn<() => Promise<string>>();
const mockConfirm = jest.fn<() => Promise<boolean>>();
jest.unstable_mockModule('@inquirer/prompts', () => ({
  select: mockSelect,
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

const { resizeCommand } = await import('./resize.js');

const runningInstance = {
  name: 'test-agent',
  instanceId: 'i-1234567890',
  state: 'running' as const,
  region: 'us-east-1',
  instanceType: 't3.medium',
  publicIp: '1.2.3.4',
};

const stoppedInstance = {
  ...runningInstance,
  state: 'stopped' as const,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveInstance.mockResolvedValue(runningInstance);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('resize command', () => {
  it('prompts with select when --type is not provided', async () => {
    mockResolveInstance.mockResolvedValue(stoppedInstance);
    mockSelect.mockResolvedValue('m6i.large');

    await resizeCommand.parseAsync(['test-agent'], { from: 'user' });

    expect(mockSelect).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Select new instance type:' })
    );
    expect(mockModifyInstanceType).toHaveBeenCalledWith('i-1234567890', 'us-east-1', 'm6i.large');
  });

  it('resizes a running instance with --type (stop, modify, start)', async () => {
    mockConfirm.mockResolvedValue(true);

    await resizeCommand.parseAsync(['test-agent', '-t', 't3.large'], { from: 'user' });

    expect(mockStopInstance).toHaveBeenCalledWith('i-1234567890', 'us-east-1');
    expect(mockWaitForInstanceStopped).toHaveBeenCalled();
    expect(mockModifyInstanceType).toHaveBeenCalledWith('i-1234567890', 'us-east-1', 't3.large');
    expect(mockStartInstance).toHaveBeenCalledWith('i-1234567890', 'us-east-1');
    expect(mockWaitForInstanceRunning).toHaveBeenCalled();
  });

  it('resizes a stopped instance without stopping first', async () => {
    mockResolveInstance.mockResolvedValue(stoppedInstance);

    await resizeCommand.parseAsync(['test-agent', '-t', 't3.large'], { from: 'user' });

    expect(mockStopInstance).not.toHaveBeenCalled();
    expect(mockModifyInstanceType).toHaveBeenCalledWith('i-1234567890', 'us-east-1', 't3.large');
    expect(mockStartInstance).toHaveBeenCalled();
  });

  it('aborts when user declines stopping a running instance', async () => {
    mockConfirm.mockResolvedValue(false);

    await resizeCommand.parseAsync(['test-agent', '-t', 't3.large'], { from: 'user' });

    expect(mockStopInstance).not.toHaveBeenCalled();
    expect(mockModifyInstanceType).not.toHaveBeenCalled();
  });

  it('throws CLIError for invalid instance type', async () => {
    await expect(
      resizeCommand.parseAsync(['test-agent', '-t', 'p4d.24xlarge'], { from: 'user' })
    ).rejects.toThrow(/Invalid instance type/);
  });

  it('does nothing when new type matches current type', async () => {
    await resizeCommand.parseAsync(['test-agent', '-t', 't3.medium'], { from: 'user' });

    expect(mockStopInstance).not.toHaveBeenCalled();
    expect(mockModifyInstanceType).not.toHaveBeenCalled();
  });

  it('passes region option through', async () => {
    mockConfirm.mockResolvedValue(true);

    await resizeCommand.parseAsync(['test-agent', '-t', 't3.large', '-r', 'us-west-2'], {
      from: 'user',
    });

    expect(mockResolveInstance).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-west-2' })
    );
  });

  it('throws CLIError when modifyInstanceType fails', async () => {
    mockResolveInstance.mockResolvedValue(stoppedInstance);
    mockModifyInstanceType.mockRejectedValue(new Error('modify failed'));

    await expect(
      resizeCommand.parseAsync(['test-agent', '-t', 't3.large'], { from: 'user' })
    ).rejects.toThrow('modify failed');
  });
});
