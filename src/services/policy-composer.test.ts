import { composeAgentPolicy, composeBoundaryPolicy, getExtraRoles } from './policy-composer.js';

describe('composeAgentPolicy', () => {
  it('composes base-only policy with no capabilities', async () => {
    const doc = await composeAgentPolicy('test-agent', []);
    const policy = JSON.parse(doc);

    expect(policy.Version).toBe('2012-10-17');
    expect(policy.Statement).toBeInstanceOf(Array);

    // Should have base statements
    const sids = policy.Statement.map((s: { Sid: string }) => s.Sid);
    expect(sids).toContain('SSMParameterAccess');
    expect(sids).toContain('CloudWatchLogsAccess');
    expect(sids).toContain('S3WorkspaceAccess');
    expect(sids).toContain('EC2SelfDescribe');
    expect(sids).toContain('SecretsManagerRead');

    // Should NOT have SageMaker statements
    expect(sids).not.toContain('SageMakerTrainingAccess');
    expect(sids).not.toContain('PassSageMakerExecutionRole');
  });

  it('composes base + sagemaker policy', async () => {
    const doc = await composeAgentPolicy('test-agent', ['sagemaker']);
    const policy = JSON.parse(doc);

    const sids = policy.Statement.map((s: { Sid: string }) => s.Sid);

    // Should have both base and SageMaker statements
    expect(sids).toContain('SSMParameterAccess');
    expect(sids).toContain('SageMakerTrainingAccess');
    expect(sids).toContain('PassSageMakerExecutionRole');
  });

  it('replaces agent name placeholder', async () => {
    const doc = await composeAgentPolicy('my-workstation', []);

    // Should have replaced ${aws:PrincipalTag/clawdult:agent} with actual name
    expect(doc).toContain('my-workstation');
    expect(doc).not.toContain('${aws:PrincipalTag/clawdult:agent}');
  });
});

describe('composeBoundaryPolicy', () => {
  it('composes strict boundary with no capabilities', async () => {
    const doc = await composeBoundaryPolicy([]);
    const policy = JSON.parse(doc);

    const sids = policy.Statement.map((s: { Sid: string }) => s.Sid);

    // Should have strict DenyAllPassRole (no exceptions)
    expect(sids).toContain('DenyAllPassRole');
    expect(sids).not.toContain('DenyPassRoleExceptSageMaker');

    // Find the DenyAllPassRole statement - should have no Condition
    const passRoleDeny = policy.Statement.find((s: { Sid: string }) => s.Sid === 'DenyAllPassRole');
    expect(passRoleDeny.Condition).toBeUndefined();
  });

  it('relaxes PassRole for SageMaker capability', async () => {
    const doc = await composeBoundaryPolicy(['sagemaker']);
    const policy = JSON.parse(doc);

    const sids = policy.Statement.map((s: { Sid: string }) => s.Sid);

    // DenyAllPassRole should be replaced with DenyPassRoleExceptSageMaker
    expect(sids).not.toContain('DenyAllPassRole');
    expect(sids).toContain('DenyPassRoleExceptSageMaker');

    // The replacement should have a Condition allowing SageMaker
    const passRoleDeny = policy.Statement.find(
      (s: { Sid: string }) => s.Sid === 'DenyPassRoleExceptSageMaker'
    );
    expect(passRoleDeny.Condition).toBeDefined();
  });

  it('always includes common denials', async () => {
    const doc = await composeBoundaryPolicy(['sagemaker']);
    const policy = JSON.parse(doc);

    const sids = policy.Statement.map((s: { Sid: string }) => s.Sid);

    expect(sids).toContain('DenyExpensiveEC2InstanceTypes');
    expect(sids).toContain('DenyIAMPrivilegeEscalation');
    expect(sids).toContain('DenyOrganizationsAccess');
    expect(sids).toContain('DenyRegionRestriction');
    expect(sids).toContain('AllowAllOtherActions');
  });
});

describe('getExtraRoles', () => {
  it('returns empty array for no capabilities', () => {
    expect(getExtraRoles([])).toEqual([]);
  });

  it('returns sagemaker role for sagemaker capability', () => {
    const roles = getExtraRoles(['sagemaker']);
    expect(roles).toEqual([{ type: 'sagemaker', service: 'sagemaker.amazonaws.com' }]);
  });
});
