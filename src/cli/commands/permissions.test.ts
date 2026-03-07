import { jest } from '@jest/globals';

const mockResolveInstance = jest.fn<() => Promise<unknown>>();
jest.unstable_mockModule('../utils/instance-resolver.js', () => ({
  resolveInstance: mockResolveInstance,
}));

jest.unstable_mockModule('../utils/require-aws.js', () => ({
  requireAwsCredentials: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

const mockListPermissionsProfiles = jest.fn<() => Promise<unknown[]>>();
const mockGetPermissionsProfile = jest.fn<() => Promise<unknown>>();
const mockGetPermissionsDescription = jest
  .fn<(p: unknown) => string>()
  .mockReturnValue('test desc');
jest.unstable_mockModule('../../services/permissions-profiles.js', () => ({
  listPermissionsProfiles: mockListPermissionsProfiles,
  getPermissionsProfile: mockGetPermissionsProfile,
  getPermissionsDescription: mockGetPermissionsDescription,
}));

const mockAttachCustomPermissions = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockDetachCustomPermissions = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/iam.js', () => ({
  attachCustomPermissions: mockAttachCustomPermissions,
  detachCustomPermissions: mockDetachCustomPermissions,
}));

const mockSetInstanceTag = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockDeleteInstanceTag = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/ec2.js', () => ({
  setInstanceTag: mockSetInstanceTag,
  deleteInstanceTag: mockDeleteInstanceTag,
}));

const mockSelect = jest.fn<() => Promise<string>>();
const mockConfirm = jest.fn<() => Promise<boolean>>();
jest.unstable_mockModule('@inquirer/prompts', () => ({
  select: mockSelect,
  confirm: mockConfirm,
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

const { permissionsCommand } = await import('./permissions.js');

const testInstance = {
  name: 'test-agent',
  instanceId: 'i-1234567890',
  state: 'running' as const,
  region: 'us-east-1',
  instanceType: 't3.medium',
  permissionsProfileName: undefined as string | undefined,
};

const testProfile = {
  name: 'db-access',
  createdAt: '2026-01-01T00:00:00Z',
  description: 'Database access',
  statements: [{ Effect: 'Allow', Action: 'rds:*', Resource: '*' }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveInstance.mockResolvedValue({ ...testInstance });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('permissions attach', () => {
  it('attaches a named profile to a workstation', async () => {
    mockGetPermissionsProfile.mockResolvedValue(testProfile);

    await permissionsCommand.parseAsync(['attach', 'test-agent', 'db-access'], {
      from: 'user',
    });

    expect(mockAttachCustomPermissions).toHaveBeenCalledWith(
      'test-agent',
      'us-east-1',
      testProfile.statements
    );
    expect(mockSetInstanceTag).toHaveBeenCalledWith(
      'i-1234567890',
      'us-east-1',
      'clawdult:permissionsProfileName',
      'db-access'
    );
  });

  it('prompts for profile selection when profile name not given', async () => {
    mockListPermissionsProfiles.mockResolvedValue([testProfile]);
    mockSelect.mockResolvedValue('db-access');
    mockGetPermissionsProfile.mockResolvedValue(testProfile);

    await permissionsCommand.parseAsync(['attach', 'test-agent'], {
      from: 'user',
    });

    expect(mockSelect).toHaveBeenCalled();
    expect(mockAttachCustomPermissions).toHaveBeenCalled();
  });

  it('returns early when no profiles exist', async () => {
    mockListPermissionsProfiles.mockResolvedValue([]);

    await permissionsCommand.parseAsync(['attach', 'test-agent'], {
      from: 'user',
    });

    expect(mockAttachCustomPermissions).not.toHaveBeenCalled();
  });

  it('returns early when named profile not found', async () => {
    mockGetPermissionsProfile.mockResolvedValue(null);

    await permissionsCommand.parseAsync(['permissions', 'attach', 'test-agent', 'nonexistent'], {
      from: 'user',
    });

    expect(mockAttachCustomPermissions).not.toHaveBeenCalled();
  });
});

describe('permissions detach', () => {
  it('detaches permissions after confirmation', async () => {
    mockResolveInstance.mockResolvedValue({
      ...testInstance,
      permissionsProfileName: 'db-access',
    });
    mockConfirm.mockResolvedValue(true);

    await permissionsCommand.parseAsync(['detach', 'test-agent'], {
      from: 'user',
    });

    expect(mockDetachCustomPermissions).toHaveBeenCalledWith('test-agent', 'us-east-1');
    expect(mockDeleteInstanceTag).toHaveBeenCalledWith(
      'i-1234567890',
      'us-east-1',
      'clawdult:permissionsProfileName'
    );
  });

  it('does nothing when no permissions are attached', async () => {
    mockResolveInstance.mockResolvedValue({ ...testInstance, permissionsProfileName: undefined });

    await permissionsCommand.parseAsync(['detach', 'test-agent'], {
      from: 'user',
    });

    expect(mockDetachCustomPermissions).not.toHaveBeenCalled();
  });

  it('aborts when user declines confirmation', async () => {
    mockResolveInstance.mockResolvedValue({
      ...testInstance,
      permissionsProfileName: 'db-access',
    });
    mockConfirm.mockResolvedValue(false);

    await permissionsCommand.parseAsync(['detach', 'test-agent'], {
      from: 'user',
    });

    expect(mockDetachCustomPermissions).not.toHaveBeenCalled();
  });
});

describe('permissions show', () => {
  it('shows profile details when permissions are attached', async () => {
    mockResolveInstance.mockResolvedValue({
      ...testInstance,
      permissionsProfileName: 'db-access',
    });
    mockGetPermissionsProfile.mockResolvedValue(testProfile);

    await permissionsCommand.parseAsync(['show', 'test-agent'], {
      from: 'user',
    });

    expect(mockGetPermissionsProfile).toHaveBeenCalledWith('db-access');
  });

  it('shows message when no permissions attached', async () => {
    mockResolveInstance.mockResolvedValue({ ...testInstance, permissionsProfileName: undefined });

    await permissionsCommand.parseAsync(['show', 'test-agent'], {
      from: 'user',
    });

    expect(mockGetPermissionsProfile).not.toHaveBeenCalled();
  });
});
