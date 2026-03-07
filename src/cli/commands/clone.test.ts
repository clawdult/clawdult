import { jest } from '@jest/globals';

const mockResolveInstance = jest.fn<() => Promise<unknown>>();
const mockRequireAwsCredentials = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockCreateAmiFromInstance = jest
  .fn<() => Promise<string>>()
  .mockResolvedValue('ami-clone123');
const mockWaitForAmiAvailable = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockLaunchInstance = jest
  .fn<() => Promise<{ instanceId: string }>>()
  .mockResolvedValue({ instanceId: 'i-newclone' });
const mockWaitForInstanceRunning = jest.fn<() => Promise<unknown>>().mockResolvedValue({
  state: 'running',
  publicIpAddress: '5.6.7.8',
  privateIpAddress: '10.0.0.1',
});
const mockGetManagedInstance = jest.fn<() => Promise<unknown>>().mockResolvedValue(null);
const mockTerminateInstance = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockEnsureIamResources = jest.fn<() => Promise<unknown>>().mockResolvedValue({
  instanceProfileName: 'clawdult-test-clone-profile',
  roleName: 'clawdult-test-clone-role',
});
const mockDeleteIamResources = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockAttachCustomPermissions = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockGetPermissionsProfile = jest.fn<() => Promise<unknown>>().mockResolvedValue(null);
const mockCopySSMParameters = jest.fn<() => Promise<unknown>>().mockResolvedValue({
  copied: ['param1', 'param2'],
  failed: [],
});
const mockGetAWSClientConfig = jest
  .fn<() => Promise<{ region: string }>>()
  .mockResolvedValue({ region: 'us-east-1' });
const mockInput = jest.fn<() => Promise<string>>().mockResolvedValue('test-clone');
const mockConfirm = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);

const mockEC2Send = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule('@aws-sdk/client-ec2', () => ({
  EC2Client: jest.fn().mockImplementation(() => ({ send: mockEC2Send })),
  DescribeInstancesCommand: jest.fn().mockImplementation((args: unknown) => args),
  DescribeVolumesCommand: jest.fn().mockImplementation((args: unknown) => args),
}));

jest.unstable_mockModule('../../services/ec2.js', () => ({
  createAmiFromInstance: mockCreateAmiFromInstance,
  waitForAmiAvailable: mockWaitForAmiAvailable,
  launchInstance: mockLaunchInstance,
  waitForInstanceRunning: mockWaitForInstanceRunning,
  getManagedInstance: mockGetManagedInstance,
  terminateInstance: mockTerminateInstance,
}));

jest.unstable_mockModule('../../services/aws-client.js', () => ({
  getAWSClientConfig: mockGetAWSClientConfig,
}));

jest.unstable_mockModule('../../services/iam.js', () => ({
  ensureIamResources: mockEnsureIamResources,
  deleteIamResources: mockDeleteIamResources,
  attachCustomPermissions: mockAttachCustomPermissions,
}));

jest.unstable_mockModule('../../services/permissions-profiles.js', () => ({
  getPermissionsProfile: mockGetPermissionsProfile,
}));

jest.unstable_mockModule('../../services/ssm.js', () => ({
  copySSMParameters: mockCopySSMParameters,
}));

jest.unstable_mockModule('../utils/require-aws.js', () => ({
  requireAwsCredentials: mockRequireAwsCredentials,
}));

jest.unstable_mockModule('../utils/instance-resolver.js', () => ({
  resolveInstance: mockResolveInstance,
}));

jest.unstable_mockModule('@inquirer/prompts', () => ({
  input: mockInput,
  confirm: mockConfirm,
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

const { cloneCommand } = await import('./clone.js');

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
              SecurityGroups: [{ GroupId: 'sg-abc123' }],
              KeyName: 'my-key',
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

const mockProcessExit = jest.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit');
}) as never);

beforeEach(() => {
  jest.clearAllMocks();
  mockProcessExit.mockImplementation((() => {
    throw new Error('process.exit');
  }) as never);
  mockResolveInstance.mockResolvedValue(testInstance);
  mockGetManagedInstance.mockResolvedValue(null);
  mockConfirm.mockResolvedValue(true);
  // Reset Commander sticky options
  cloneCommand.setOptionValue('type', undefined);
  cloneCommand.setOptionValue('region', undefined);
  setupEC2Mocks();
});

describe('cloneCommand', () => {
  it('clones a workstation end-to-end', async () => {
    await cloneCommand.parseAsync(['test-agent', 'my-clone'], { from: 'user' });

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
      expect.stringContaining('clawdult-clone-my-clone-'),
      'Clone of test-agent for my-clone'
    );
    expect(mockWaitForAmiAvailable).toHaveBeenCalled();
    expect(mockEnsureIamResources).toHaveBeenCalledWith('my-clone', 'us-east-1');
    expect(mockCopySSMParameters).toHaveBeenCalledWith('test-agent', 'my-clone', 'us-east-1');
    expect(mockLaunchInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'my-clone',
        instanceType: 't3.medium',
        region: 'us-east-1',
        volumeSize: 80,
        amiId: 'ami-clone123',
        securityGroupIds: ['sg-abc123'],
        keyName: 'my-key',
        iamInstanceProfile: 'clawdult-test-clone-profile',
        keyProfileName: 'my-keys',
      })
    );
    expect(mockWaitForInstanceRunning).toHaveBeenCalledWith(
      'i-newclone',
      'us-east-1',
      expect.objectContaining({ onProgress: expect.any(Function) })
    );
  });

  it('aborts when user declines confirmation', async () => {
    mockConfirm.mockResolvedValueOnce(false);

    await cloneCommand.parseAsync(['test-agent', 'abort-clone'], { from: 'user' });

    expect(mockCreateAmiFromInstance).not.toHaveBeenCalled();
    expect(mockLaunchInstance).not.toHaveBeenCalled();
  });

  it('throws when target name already exists', async () => {
    mockGetManagedInstance.mockResolvedValueOnce({ state: 'running' });

    await expect(
      cloneCommand.parseAsync(['test-agent', 'existing-clone'], { from: 'user' })
    ).rejects.toThrow("Workstation 'existing-clone' already exists");
  });

  it('uses custom instance type when provided', async () => {
    await cloneCommand.parseAsync(['test-agent', 'typed-clone', '--type', 't3.large'], {
      from: 'user',
    });

    expect(mockLaunchInstance).toHaveBeenCalledWith(
      expect.objectContaining({ instanceType: 't3.large' })
    );
  });

  it('throws on invalid instance type', async () => {
    await expect(
      cloneCommand.parseAsync(['test-agent', 'bad-type-clone', '--type', 'p4d.24xlarge'], {
        from: 'user',
      })
    ).rejects.toThrow("Invalid instance type 'p4d.24xlarge'");
  });

  it('attaches permissions profile when source has one', async () => {
    mockResolveInstance.mockResolvedValueOnce({
      ...testInstance,
      permissionsProfileName: 'custom-perms',
    });
    mockGetPermissionsProfile.mockResolvedValueOnce({
      name: 'custom-perms',
      statements: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }],
    });

    await cloneCommand.parseAsync(['test-agent', 'perms-clone'], { from: 'user' });

    expect(mockGetPermissionsProfile).toHaveBeenCalledWith('custom-perms');
    expect(mockAttachCustomPermissions).toHaveBeenCalledWith('perms-clone', 'us-east-1', [
      { Effect: 'Allow', Action: 's3:*', Resource: '*' },
    ]);
  });

  it('cleans up on failure after instance launched', async () => {
    mockWaitForInstanceRunning.mockRejectedValueOnce(new Error('instance failed'));

    await expect(
      cloneCommand.parseAsync(['test-agent', 'fail-clone'], { from: 'user' })
    ).rejects.toThrow('process.exit');

    expect(mockTerminateInstance).toHaveBeenCalledWith('i-newclone', 'us-east-1');
    expect(mockDeleteIamResources).toHaveBeenCalledWith('fail-clone', 'us-east-1');
  });

  it('cleans up IAM but not instance when failure occurs before launch', async () => {
    mockCopySSMParameters.mockRejectedValueOnce(new Error('SSM copy failed'));

    await expect(
      cloneCommand.parseAsync(['test-agent', 'ssm-fail-clone'], { from: 'user' })
    ).rejects.toThrow('process.exit');

    expect(mockTerminateInstance).not.toHaveBeenCalled();
    expect(mockDeleteIamResources).toHaveBeenCalledWith('ssm-fail-clone', 'us-east-1');
  });
});
