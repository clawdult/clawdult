import { jest } from '@jest/globals';

const mockRequireAwsCredentials = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockDescribeAmi = jest
  .fn<() => Promise<unknown>>()
  .mockResolvedValue({ amiId: 'ami-source-123' });
const mockCopyAmiToRegion = jest.fn<() => Promise<string>>().mockResolvedValue('ami-copied-456');
const mockWaitForAmiAvailable = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockLaunchInstance = jest
  .fn<() => Promise<{ instanceId: string }>>()
  .mockResolvedValue({ instanceId: 'i-restored' });
const mockWaitForInstanceRunning = jest.fn<() => Promise<unknown>>().mockResolvedValue({
  state: 'running',
  publicIpAddress: '9.8.7.6',
  privateIpAddress: '10.0.0.5',
});
const mockEnsureSSHSecurityGroup = jest
  .fn<() => Promise<string>>()
  .mockResolvedValue('sg-restore123');
const mockGetManagedInstance = jest.fn<() => Promise<unknown>>().mockResolvedValue(null);
const mockTerminateInstance = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockLoadGlobalConfig = jest.fn<() => Promise<unknown>>().mockResolvedValue({
  allowedSshCidr: '0.0.0.0/0',
  sshKeyName: 'my-ssh-key',
});
const mockEnsureIamResources = jest.fn<() => Promise<unknown>>().mockResolvedValue({
  instanceProfileName: 'clawdult-restored-profile',
  roleName: 'clawdult-restored-role',
});
const mockDeleteIamResources = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockAttachCustomPermissions = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockGetPermissionsProfile = jest.fn<() => Promise<unknown>>().mockResolvedValue(null);
const mockPushKeyProfileToSSM = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockPushGitHubCredentialsToSSM = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockPushConnectivityProfileToSSM = jest
  .fn<() => Promise<void>>()
  .mockResolvedValue(undefined);
const mockGetProfileWithKeys = jest
  .fn<() => Promise<unknown>>()
  .mockResolvedValue({ name: 'my-keys' });
const mockListSnapshots = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
const mockGetSnapshot = jest.fn<() => Promise<unknown>>();
const mockInput = jest.fn<() => Promise<string>>().mockResolvedValue('restored-ws');
const mockSelect = jest.fn<() => Promise<string>>().mockResolvedValue('my-snapshot');

jest.unstable_mockModule('../../../services/ec2.js', () => ({
  describeAmi: mockDescribeAmi,
  copyAmiToRegion: mockCopyAmiToRegion,
  waitForAmiAvailable: mockWaitForAmiAvailable,
  launchInstance: mockLaunchInstance,
  waitForInstanceRunning: mockWaitForInstanceRunning,
  ensureSSHSecurityGroup: mockEnsureSSHSecurityGroup,
  getManagedInstance: mockGetManagedInstance,
  terminateInstance: mockTerminateInstance,
}));

jest.unstable_mockModule('../../../services/config.js', () => ({
  loadGlobalConfig: mockLoadGlobalConfig,
}));

jest.unstable_mockModule('../../../services/iam.js', () => ({
  ensureIamResources: mockEnsureIamResources,
  deleteIamResources: mockDeleteIamResources,
  attachCustomPermissions: mockAttachCustomPermissions,
}));

jest.unstable_mockModule('../../../services/permissions-profiles.js', () => ({
  getPermissionsProfile: mockGetPermissionsProfile,
}));

jest.unstable_mockModule('../../../services/ssm.js', () => ({
  pushKeyProfileToSSM: mockPushKeyProfileToSSM,
  pushGitHubCredentialsToSSM: mockPushGitHubCredentialsToSSM,
  pushConnectivityProfileToSSM: mockPushConnectivityProfileToSSM,
}));

jest.unstable_mockModule('../../../services/key-profiles.js', () => ({
  getProfileWithKeys: mockGetProfileWithKeys,
}));

jest.unstable_mockModule('../../../services/workstation-snapshots.js', () => ({
  listSnapshots: mockListSnapshots,
  getSnapshot: mockGetSnapshot,
}));

jest.unstable_mockModule('../../utils/require-aws.js', () => ({
  requireAwsCredentials: mockRequireAwsCredentials,
}));

jest.unstable_mockModule('@inquirer/prompts', () => ({
  input: mockInput,
  select: mockSelect,
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

const { restoreCommand } = await import('./restore.js');

const testSnapshot = {
  name: 'my-snapshot',
  createdAt: '2024-01-01T00:00:00Z',
  amiId: 'ami-source-123',
  amiRegion: 'us-east-1',
  sourceWorkstationName: 'original-agent',
  sourceInstanceId: 'i-original',
  instanceType: 't3.medium',
  region: 'us-east-1',
  volumeSize: 50,
  keyProfileName: 'my-keys',
  permissionsProfileName: undefined,
  githubAgentUsername: undefined,
  connectivityProfileName: undefined,
};

const mockProcessExit = jest.spyOn(process, 'exit').mockImplementation((() => {
  throw new Error('process.exit');
}) as never);

beforeEach(() => {
  jest.clearAllMocks();
  mockProcessExit.mockImplementation((() => {
    throw new Error('process.exit');
  }) as never);
  mockGetSnapshot.mockResolvedValue(testSnapshot);
  mockGetManagedInstance.mockResolvedValue(null);
  mockGetProfileWithKeys.mockResolvedValue({ name: 'my-keys' });
  // Reset Commander sticky options
  restoreCommand.setOptionValue('name', undefined);
  restoreCommand.setOptionValue('type', undefined);
  restoreCommand.setOptionValue('region', undefined);
});

describe('restoreCommand', () => {
  it('restores a snapshot with provided name', async () => {
    await restoreCommand.parseAsync(['my-snapshot', '--name', 'restored-ws'], { from: 'user' });

    expect(mockRequireAwsCredentials).toHaveBeenCalled();
    expect(mockGetSnapshot).toHaveBeenCalledWith('my-snapshot');
    expect(mockDescribeAmi).toHaveBeenCalledWith('ami-source-123', 'us-east-1');
    expect(mockEnsureSSHSecurityGroup).toHaveBeenCalledWith('us-east-1', '0.0.0.0/0');
    expect(mockEnsureIamResources).toHaveBeenCalledWith('restored-ws', 'us-east-1');
    expect(mockPushKeyProfileToSSM).toHaveBeenCalledWith('restored-ws', 'us-east-1', 'my-keys');
    expect(mockLaunchInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'restored-ws',
        instanceType: 't3.medium',
        region: 'us-east-1',
        volumeSize: 50,
        amiId: 'ami-source-123',
        securityGroupIds: ['sg-restore123'],
        keyName: 'my-ssh-key',
        iamInstanceProfile: 'clawdult-restored-profile',
        keyProfileName: 'my-keys',
      })
    );
    expect(mockWaitForInstanceRunning).toHaveBeenCalledWith(
      'i-restored',
      'us-east-1',
      expect.objectContaining({ onProgress: expect.any(Function) })
    );
  });

  it('throws when snapshot not found', async () => {
    mockGetSnapshot.mockResolvedValueOnce(null);

    await expect(
      restoreCommand.parseAsync(['nonexistent', '--name', 'ws'], { from: 'user' })
    ).rejects.toThrow("Snapshot 'nonexistent' not found");
  });

  it('throws when AMI no longer exists', async () => {
    mockDescribeAmi.mockResolvedValueOnce(null);

    await expect(
      restoreCommand.parseAsync(['my-snapshot', '--name', 'ws'], { from: 'user' })
    ).rejects.toThrow('AMI ami-source-123 no longer exists');
  });

  it('throws when target name already exists', async () => {
    mockGetManagedInstance.mockResolvedValueOnce({ state: 'running' });

    await expect(
      restoreCommand.parseAsync(['my-snapshot', '--name', 'existing-ws'], { from: 'user' })
    ).rejects.toThrow("Workstation 'existing-ws' already exists");
  });

  it('copies AMI cross-region when target region differs', async () => {
    await restoreCommand.parseAsync(
      ['my-snapshot', '--name', 'cross-region-ws', '--region', 'us-west-2'],
      { from: 'user' }
    );

    expect(mockCopyAmiToRegion).toHaveBeenCalledWith(
      'ami-source-123',
      'us-east-1',
      'us-west-2',
      expect.stringContaining('clawdult-restore-cross-region-ws-')
    );
    expect(mockWaitForAmiAvailable).toHaveBeenCalledWith('ami-copied-456', 'us-west-2', {
      maxWaitTimeSeconds: 900,
    });
    expect(mockLaunchInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        amiId: 'ami-copied-456',
        region: 'us-west-2',
      })
    );
  });

  it('does not copy AMI when target region matches snapshot region', async () => {
    await restoreCommand.parseAsync(['my-snapshot', '--name', 'same-region-ws'], { from: 'user' });

    expect(mockCopyAmiToRegion).not.toHaveBeenCalled();
    expect(mockLaunchInstance).toHaveBeenCalledWith(
      expect.objectContaining({ amiId: 'ami-source-123' })
    );
  });

  it('uses custom instance type', async () => {
    await restoreCommand.parseAsync(['my-snapshot', '--name', 'typed-ws', '--type', 't3.large'], {
      from: 'user',
    });

    expect(mockLaunchInstance).toHaveBeenCalledWith(
      expect.objectContaining({ instanceType: 't3.large' })
    );
  });

  it('throws on invalid instance type', async () => {
    await expect(
      restoreCommand.parseAsync(
        ['my-snapshot', '--name', 'bad-type-ws', '--type', 'p4d.24xlarge'],
        { from: 'user' }
      )
    ).rejects.toThrow("Invalid instance type 'p4d.24xlarge'");
  });

  it('pushes GitHub credentials when snapshot has github username', async () => {
    mockGetSnapshot.mockResolvedValueOnce({
      ...testSnapshot,
      githubAgentUsername: 'bot-user',
    });

    await restoreCommand.parseAsync(['my-snapshot', '--name', 'gh-ws'], { from: 'user' });

    expect(mockPushGitHubCredentialsToSSM).toHaveBeenCalledWith('gh-ws', 'us-east-1', {
      username: 'bot-user',
      email: 'bot-user@users.noreply.github.com',
      createdAt: expect.any(String),
    });
  });

  it('cleans up on failure after instance launched', async () => {
    mockWaitForInstanceRunning.mockRejectedValueOnce(new Error('instance timeout'));

    await expect(
      restoreCommand.parseAsync(['my-snapshot', '--name', 'fail-ws'], { from: 'user' })
    ).rejects.toThrow('process.exit');

    expect(mockTerminateInstance).toHaveBeenCalledWith('i-restored', 'us-east-1');
    expect(mockDeleteIamResources).toHaveBeenCalledWith('fail-ws', 'us-east-1');
  });

  it('cleans up IAM only when failure occurs before launch', async () => {
    mockEnsureSSHSecurityGroup.mockRejectedValueOnce(new Error('SG failed'));

    await expect(
      restoreCommand.parseAsync(['my-snapshot', '--name', 'sg-fail-ws'], { from: 'user' })
    ).rejects.toThrow('process.exit');

    expect(mockTerminateInstance).not.toHaveBeenCalled();
    expect(mockDeleteIamResources).not.toHaveBeenCalled();
  });
});
