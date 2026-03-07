import { jest } from '@jest/globals';

const mockResolveInstance = jest.fn<() => Promise<unknown>>();
const mockRequireAwsCredentials = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockCreateAmiFromInstance = jest.fn<() => Promise<string>>().mockResolvedValue('ami-snap123');
const mockWaitForAmiAvailable = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockSaveSnapshot = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockGetSnapshot = jest.fn<() => Promise<unknown>>().mockResolvedValue(null);
const mockGetAWSClientConfig = jest
  .fn<() => Promise<{ region: string }>>()
  .mockResolvedValue({ region: 'us-east-1' });
const mockInput = jest.fn<() => Promise<string>>().mockResolvedValue('my-snapshot');

const mockEC2Send = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn().mockImplementation(() => ({ send: mockEC2Send })),
  DescribeInstancesCommand: jest.fn().mockImplementation((args: unknown) => args),
  DescribeVolumesCommand: jest.fn().mockImplementation((args: unknown) => args),
}));

jest.unstable_mockModule('../../../services/ec2.js', () => ({
  createAmiFromInstance: mockCreateAmiFromInstance,
  waitForAmiAvailable: mockWaitForAmiAvailable,
}));

jest.unstable_mockModule('../../../services/aws-client.js', () => ({
  getAWSClientConfig: mockGetAWSClientConfig,
}));

jest.unstable_mockModule('../../../services/workstation-snapshots.js', () => ({
  saveSnapshot: mockSaveSnapshot,
  getSnapshot: mockGetSnapshot,
}));

jest.unstable_mockModule('../../utils/require-aws.js', () => ({
  requireAwsCredentials: mockRequireAwsCredentials,
}));

jest.unstable_mockModule('../../utils/instance-resolver.js', () => ({
  resolveInstance: mockResolveInstance,
}));

jest.unstable_mockModule('@inquirer/prompts', () => ({
  input: mockInput,
}));

jest.unstable_mockModule('ora', () => ({
  default: () => ({
    start: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    warn: jest.fn().mockReturnThis(),
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

const { saveCommand } = await import('./save.js');

const testInstance = {
  name: 'test-agent',
  instanceId: 'i-1234567890',
  state: 'running' as const,
  region: 'us-east-1',
  instanceType: 't3.medium',
  publicIp: '1.2.3.4',
  keyProfileName: 'my-keys',
  permissionsProfileName: undefined,
  githubAgentUsername: undefined,
};

function setupEC2Mocks(volumeSize = 80) {
  mockEC2Send
    .mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              BlockDeviceMappings: [{ Ebs: { VolumeId: 'vol-abc123' } }],
            },
          ],
        },
      ],
    })
    .mockResolvedValueOnce({
      Volumes: [{ Size: volumeSize }],
    });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveInstance.mockResolvedValue(testInstance);
  mockGetSnapshot.mockResolvedValue(null);
  setupEC2Mocks();
});

describe('saveCommand', () => {
  it('saves a snapshot with provided name', async () => {
    await saveCommand.parseAsync(['test-agent', '--name', 'my-snap'], { from: 'user' });

    expect(mockRequireAwsCredentials).toHaveBeenCalled();
    expect(mockResolveInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'test-agent',
        filterStates: ['running', 'stopped'],
      })
    );
    expect(mockCreateAmiFromInstance).toHaveBeenCalledWith(
      'i-1234567890',
      'us-east-1',
      expect.stringContaining('clawdult-snapshot-my-snap-'),
      expect.any(String)
    );
    expect(mockWaitForAmiAvailable).toHaveBeenCalledWith('ami-snap123', 'us-east-1', {
      maxWaitTimeSeconds: 900,
    });
    expect(mockSaveSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'my-snap',
        amiId: 'ami-snap123',
        amiRegion: 'us-east-1',
        sourceWorkstationName: 'test-agent',
        sourceInstanceId: 'i-1234567890',
        instanceType: 't3.medium',
        volumeSize: 80,
        keyProfileName: 'my-keys',
      })
    );
  });

  it('prompts for name when not provided via option', async () => {
    mockInput.mockResolvedValueOnce('prompted-name');

    // Commander caches options on the command instance between parseAsync calls,
    // so we must explicitly reset the --name option before testing the no-name path.
    saveCommand.setOptionValue('name', undefined);
    await saveCommand.parseAsync(['test-agent'], { from: 'user' });

    expect(mockInput).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Snapshot name:',
      })
    );
    expect(mockSaveSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'prompted-name' })
    );
  });

  it('throws when snapshot name already exists', async () => {
    mockGetSnapshot.mockResolvedValueOnce({ name: 'existing-snap' });

    await expect(
      saveCommand.parseAsync(['test-agent', '--name', 'existing-snap'], { from: 'user' })
    ).rejects.toThrow("Snapshot 'existing-snap' already exists");
  });

  it('defaults volume size to 50 when no root volume found', async () => {
    mockEC2Send.mockReset();
    mockEC2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [{ BlockDeviceMappings: [] }],
        },
      ],
    });

    await saveCommand.parseAsync(['test-agent', '--name', 'no-vol'], { from: 'user' });

    expect(mockSaveSnapshot).toHaveBeenCalledWith(expect.objectContaining({ volumeSize: 50 }));
  });

  it('uses custom description when provided', async () => {
    await saveCommand.parseAsync(
      ['test-agent', '--name', 'desc-snap', '--description', 'My custom description'],
      { from: 'user' }
    );

    expect(mockCreateAmiFromInstance).toHaveBeenCalledWith(
      'i-1234567890',
      'us-east-1',
      expect.any(String),
      'My custom description'
    );
    expect(mockSaveSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'My custom description' })
    );
  });

  it('throws CLIError when AMI creation fails', async () => {
    mockCreateAmiFromInstance.mockRejectedValueOnce(new Error('AMI creation failed'));

    await expect(
      saveCommand.parseAsync(['test-agent', '--name', 'fail-snap'], { from: 'user' })
    ).rejects.toThrow('AMI creation failed');
  });
});
