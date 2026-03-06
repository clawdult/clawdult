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
    PutRolePolicyCommand: cmd('PutRolePolicyCommand'),
    DeleteRolePolicyCommand: cmd('DeleteRolePolicyCommand'),
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

const mockComposeAgentPolicy = jest.fn<() => Promise<string>>();
const mockComposeBoundaryPolicy = jest.fn<() => Promise<string>>();
const mockGetExtraRoles = jest.fn<() => Array<{ type: string; service: string }>>();

jest.unstable_mockModule('./policy-composer.js', () => ({
  composeAgentPolicy: mockComposeAgentPolicy,
  composeBoundaryPolicy: mockComposeBoundaryPolicy,
  getExtraRoles: mockGetExtraRoles,
}));

// Dynamic import after mocks
const { ensureIamResources, deleteIamResources } = await import('./iam.js');

// --- Tests ---

describe('IAM resource naming', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSTSClientSend.mockResolvedValue({ Account: '123456789012' });
    mockComposeAgentPolicy.mockResolvedValue('{"Version":"2012-10-17","Statement":[]}');
    mockComposeBoundaryPolicy.mockResolvedValue('{"Version":"2012-10-17","Statement":[]}');
    mockGetExtraRoles.mockReturnValue([]);
  });

  it('ensureIamResources uses correct naming convention (no capabilities)', async () => {
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
    expect(result.extraRoles).toEqual([]);
  }, 15000);

  it('ensureIamResources creates SageMaker role when sagemaker capability is present', async () => {
    mockGetExtraRoles.mockReturnValue([{ type: 'sagemaker', service: 'sagemaker.amazonaws.com' }]);

    mockIAMClientSend
      // ensurePermissionBoundary
      .mockResolvedValueOnce({})
      // ensureAgentPolicy
      .mockResolvedValueOnce({})
      // ensureRole
      .mockResolvedValueOnce({
        Role: { Arn: 'arn:aws:iam::123456789012:role/clawdult-test-agent-role' },
      })
      // ensureInstanceProfile
      .mockResolvedValueOnce({
        InstanceProfile: {
          Arn: 'arn:aws:iam::123456789012:instance-profile/clawdult-test-agent-profile',
        },
      })
      // attachPoliciesToRole
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      // addRoleToInstanceProfile
      .mockResolvedValueOnce({})
      // ensureSageMakerRole - CreateRoleCommand + PutRolePolicyCommand
      .mockResolvedValueOnce({
        Role: { Arn: 'arn:aws:iam::123456789012:role/clawdult-test-agent-sagemaker-role' },
      })
      .mockResolvedValueOnce({})
      // waitForInstanceProfileReady
      .mockResolvedValueOnce({
        InstanceProfile: {
          Roles: [{ RoleName: 'clawdult-test-agent-role' }],
        },
      });

    const result = await ensureIamResources('test-agent', 'us-east-1', ['sagemaker']);

    expect(result.extraRoles).toEqual([
      {
        roleName: 'clawdult-test-agent-sagemaker-role',
        roleArn: 'arn:aws:iam::123456789012:role/clawdult-test-agent-sagemaker-role',
        type: 'sagemaker',
      },
    ]);
    expect(mockComposeAgentPolicy).toHaveBeenCalledWith('test-agent', ['sagemaker']);
    expect(mockComposeBoundaryPolicy).toHaveBeenCalledWith(['sagemaker']);
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

  it('deletes all resources in correct order (no capabilities = backwards compat SageMaker cleanup)', async () => {
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
      'DeleteRolePolicyCommand',
      'DeleteRoleCommand',
      'DeletePolicyCommand',
    ]);
  });

  it('skips SageMaker cleanup when capabilities are empty', async () => {
    const callOrder: string[] = [];

    mockIAMClientSend.mockImplementation(async (cmd: unknown) => {
      const cmdName = (cmd as { constructor: { _name: string } }).constructor._name;
      callOrder.push(cmdName);

      if (cmdName === 'ListAttachedRolePoliciesCommand') {
        return { AttachedPolicies: [] };
      }
      return {};
    });

    await deleteIamResources('test', 'us-east-1', []);

    // Should NOT include DeleteRolePolicyCommand or second DeleteRoleCommand for SageMaker
    expect(callOrder).toEqual([
      'ListAttachedRolePoliciesCommand',
      'RemoveRoleFromInstanceProfileCommand',
      'DeleteInstanceProfileCommand',
      'DeleteRoleCommand',
      'DeletePolicyCommand',
      'DeletePolicyCommand',
    ]);
  });

  it('includes SageMaker cleanup when sagemaker capability is present', async () => {
    const callOrder: string[] = [];

    mockIAMClientSend.mockImplementation(async (cmd: unknown) => {
      const cmdName = (cmd as { constructor: { _name: string } }).constructor._name;
      callOrder.push(cmdName);

      if (cmdName === 'ListAttachedRolePoliciesCommand') {
        return { AttachedPolicies: [] };
      }
      return {};
    });

    await deleteIamResources('test', 'us-east-1', ['sagemaker']);

    expect(callOrder).toContain('DeleteRolePolicyCommand'); // SageMaker inline policy
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
