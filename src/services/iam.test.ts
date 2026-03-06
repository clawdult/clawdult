import { jest } from '@jest/globals';

// --- Mocks ---

// Capture mock constructors so tests can inspect calls
const mockIAMClientSend = jest.fn<(cmd: unknown) => Promise<unknown>>();
const mockSTSClientSend = jest.fn<(cmd: unknown) => Promise<unknown>>();

jest.unstable_mockModule('@aws-sdk/client-iam', () => {
  class FakeIAMClient {
    send = mockIAMClientSend;
  }
  // Minimal command stubs -- just need constructable classes
  const cmd = (name: string) =>
    class {
      static _name = name;
      input: unknown;
      constructor(input: unknown) {
        this.input = input;
      }
    };
  return {
    IAMClient: FakeIAMClient,
    CreatePolicyCommand: cmd('CreatePolicyCommand'),
    CreateRoleCommand: cmd('CreateRoleCommand'),
    CreateInstanceProfileCommand: cmd('CreateInstanceProfileCommand'),
    AttachRolePolicyCommand: cmd('AttachRolePolicyCommand'),
    AddRoleToInstanceProfileCommand: cmd('AddRoleToInstanceProfileCommand'),
    GetInstanceProfileCommand: cmd('GetInstanceProfileCommand'),
    DeletePolicyCommand: cmd('DeletePolicyCommand'),
    DeleteRoleCommand: cmd('DeleteRoleCommand'),
    DeleteInstanceProfileCommand: cmd('DeleteInstanceProfileCommand'),
    DetachRolePolicyCommand: cmd('DetachRolePolicyCommand'),
    RemoveRoleFromInstanceProfileCommand: cmd('RemoveRoleFromInstanceProfileCommand'),
    ListAttachedRolePoliciesCommand: cmd('ListAttachedRolePoliciesCommand'),
    GetRoleCommand: cmd('GetRoleCommand'),
    ListPolicyVersionsCommand: cmd('ListPolicyVersionsCommand'),
    DeletePolicyVersionCommand: cmd('DeletePolicyVersionCommand'),
  };
});

jest.unstable_mockModule('@aws-sdk/client-sts', () => {
  class FakeSTSClient {
    send = mockSTSClientSend;
  }
  return {
    STSClient: FakeSTSClient,
    GetCallerIdentityCommand: class {
      constructor() {}
    },
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

// Dynamic import after mocks
const { ensureIamResources, deleteIamResources } = await import('./iam.js');

// --- Tests ---

describe('IAM resource naming', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSTSClientSend.mockResolvedValue({ Account: '123456789012' });
  });

  it('ensureIamResources uses correct naming convention', async () => {
    mockIAMClientSend
      // ensurePermissionBoundary - CreatePolicyCommand
      .mockResolvedValueOnce({})
      // ensureAgentPolicy - CreatePolicyCommand
      .mockResolvedValueOnce({})
      // ensureRole - CreateRoleCommand
      .mockResolvedValueOnce({
        Role: { Arn: 'arn:aws:iam::123456789012:role/clawdult-test-agent-role' },
      })
      // ensureInstanceProfile - CreateInstanceProfileCommand
      .mockResolvedValueOnce({
        InstanceProfile: {
          Arn: 'arn:aws:iam::123456789012:instance-profile/clawdult-test-agent-profile',
        },
      })
      // attachPoliciesToRole - 2 AttachRolePolicyCommands
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      // addRoleToInstanceProfile
      .mockResolvedValueOnce({})
      // waitForInstanceProfileReady - GetInstanceProfileCommand
      .mockResolvedValueOnce({
        InstanceProfile: {
          Roles: [{ RoleName: 'clawdult-test-agent-role' }],
        },
      });

    const result = await ensureIamResources('test-agent', 'us-east-1');

    expect(result.roleName).toBe('clawdult-test-agent-role');
    expect(result.instanceProfileName).toBe('clawdult-test-agent-profile');
    expect(result.policyArn).toBe('arn:aws:iam::123456789012:policy/clawdult-test-agent-policy');
    expect(result.boundaryArn).toBe(
      'arn:aws:iam::123456789012:policy/clawdult-test-agent-boundary'
    );
    expect(result.roleArn).toBe('arn:aws:iam::123456789012:role/clawdult-test-agent-role');
    expect(result.instanceProfileArn).toBe(
      'arn:aws:iam::123456789012:instance-profile/clawdult-test-agent-profile'
    );
  }, 15000);

  it('ensureIamResources handles EntityAlreadyExistsException for all resources', async () => {
    const alreadyExists = new Error('already exists');
    alreadyExists.name = 'EntityAlreadyExistsException';

    mockIAMClientSend
      // ensurePermissionBoundary - already exists
      .mockRejectedValueOnce(alreadyExists)
      // ensureAgentPolicy - already exists
      .mockRejectedValueOnce(alreadyExists)
      // ensureRole - already exists, then GetRole
      .mockRejectedValueOnce(alreadyExists)
      .mockResolvedValueOnce({
        Role: { Arn: 'arn:aws:iam::123456789012:role/clawdult-my-agent-role' },
      })
      // ensureInstanceProfile - already exists, then GetInstanceProfile
      .mockRejectedValueOnce(alreadyExists)
      .mockResolvedValueOnce({
        InstanceProfile: {
          Arn: 'arn:aws:iam::123456789012:instance-profile/clawdult-my-agent-profile',
        },
      })
      // attachPoliciesToRole
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      // addRoleToInstanceProfile
      .mockResolvedValueOnce({})
      // waitForInstanceProfileReady
      .mockResolvedValueOnce({
        InstanceProfile: {
          Roles: [{ RoleName: 'clawdult-my-agent-role' }],
        },
      });

    const result = await ensureIamResources('my-agent', 'us-east-1');

    expect(result.roleName).toBe('clawdult-my-agent-role');
    expect(result.instanceProfileName).toBe('clawdult-my-agent-profile');
  }, 15000);

  it('ensureIamResources propagates non-EntityAlreadyExists errors', async () => {
    const accessDenied = new Error('Access denied');
    accessDenied.name = 'AccessDeniedException';

    mockIAMClientSend.mockRejectedValueOnce(accessDenied);

    await expect(ensureIamResources('fail-agent', 'us-east-1')).rejects.toThrow('Access denied');
  });
});

describe('deleteIamResources', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSTSClientSend.mockResolvedValue({ Account: '123456789012' });
  });

  it('deletes all resources in correct order', async () => {
    const callOrder: string[] = [];

    mockIAMClientSend.mockImplementation(async (cmd: unknown) => {
      const cmdName = (cmd as { constructor: { _name: string } }).constructor._name;
      callOrder.push(cmdName);

      if (cmdName === 'ListAttachedRolePoliciesCommand') {
        return {
          AttachedPolicies: [
            { PolicyArn: 'arn:aws:iam::123456789012:policy/clawdult-test-policy' },
            { PolicyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore' },
          ],
        };
      }
      return {};
    });

    await deleteIamResources('test', 'us-east-1');

    expect(callOrder).toEqual([
      'ListAttachedRolePoliciesCommand',
      'DetachRolePolicyCommand',
      'DetachRolePolicyCommand',
      'RemoveRoleFromInstanceProfileCommand',
      'DeleteInstanceProfileCommand',
      'DeleteRoleCommand',
      'DeletePolicyCommand',
      'DeletePolicyCommand',
      'DeletePolicyCommand',
    ]);
  });

  it('ignores NoSuchEntityException during deletion', async () => {
    const notFound = new Error('not found');
    notFound.name = 'NoSuchEntityException';

    mockIAMClientSend.mockRejectedValue(notFound);

    // Should not throw
    await deleteIamResources('nonexistent', 'us-east-1');
  });

  it('propagates non-NoSuchEntity errors during deletion', async () => {
    const forbidden = new Error('Forbidden');
    forbidden.name = 'ForbiddenException';

    mockIAMClientSend.mockRejectedValue(forbidden);

    await expect(deleteIamResources('fail', 'us-east-1')).rejects.toThrow('Forbidden');
  });
});
