import {
  IAMClient,
  CreatePolicyCommand,
  CreateRoleCommand,
  CreateInstanceProfileCommand,
  AttachRolePolicyCommand,
  AddRoleToInstanceProfileCommand,
  GetInstanceProfileCommand,
  DeletePolicyCommand,
  DeleteRoleCommand,
  DeleteInstanceProfileCommand,
  DetachRolePolicyCommand,
  RemoveRoleFromInstanceProfileCommand,
  ListAttachedRolePoliciesCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  ListPolicyVersionsCommand,
  DeletePolicyVersionCommand,
} from '@aws-sdk/client-iam';
import type { IamStatement } from '../schemas/config.js';
import { getAWSClientConfig } from './aws-client.js';
import { retryWithBackoff } from './aws-retry.js';
import { composeAgentPolicy, composeBoundaryPolicy, getExtraRoles } from './policy-composer.js';
import type { CapabilityModule } from '../schemas/config.js';

export interface ExtraRoleInfo {
  roleName: string;
  roleArn: string;
  type: string;
}

export interface IamResources {
  instanceProfileName: string;
  instanceProfileArn: string;
  roleName: string;
  roleArn: string;
  policyArn: string;
  boundaryArn: string;
  extraRoles: ExtraRoleInfo[];
}

// Naming convention for IAM resources
function getRoleName(name: string): string {
  return `clawdult-${name}-role`;
}

function getPolicyName(name: string): string {
  return `clawdult-${name}-policy`;
}

function getBoundaryName(name: string): string {
  return `clawdult-${name}-boundary`;
}

function getProfileName(name: string): string {
  return `clawdult-${name}-profile`;
}

function getSageMakerRoleName(name: string): string {
  return `clawdult-${name}-sagemaker-role`;
}

function getCustomPolicyName(name: string): string {
  return `clawdult-${name}-custom-policy`;
}

async function createIAMClient(region: string): Promise<IAMClient> {
  return new IAMClient(await getAWSClientConfig(region));
}

async function getAccountId(region: string): Promise<string> {
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const stsClient = new STSClient(await getAWSClientConfig(region));
  const identity = await stsClient.send(new GetCallerIdentityCommand({}));
  return identity.Account!;
}

async function ensurePermissionBoundary(
  name: string,
  client: IAMClient,
  accountId: string,
  capabilities: CapabilityModule[]
): Promise<string> {
  const boundaryName = getBoundaryName(name);
  const boundaryArn = `arn:aws:iam::${accountId}:policy/${boundaryName}`;

  try {
    const policyDocument = await composeBoundaryPolicy(capabilities);

    await client.send(
      new CreatePolicyCommand({
        PolicyName: boundaryName,
        PolicyDocument: policyDocument,
        Description: `Permission boundary for clawdult workstation ${name}`,
        Tags: [
          { Key: 'clawdult:managed', Value: 'true' },
          { Key: 'clawdult:agent', Value: name },
        ],
      })
    );

    return boundaryArn;
  } catch (error) {
    if (error instanceof Error && error.name === 'EntityAlreadyExistsException') {
      return boundaryArn;
    }
    throw error;
  }
}

async function ensureAgentPolicy(
  name: string,
  client: IAMClient,
  accountId: string,
  capabilities: CapabilityModule[]
): Promise<string> {
  const policyName = getPolicyName(name);
  const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;

  try {
    const policyDocument = await composeAgentPolicy(name, capabilities);

    await client.send(
      new CreatePolicyCommand({
        PolicyName: policyName,
        PolicyDocument: policyDocument,
        Description: `Agent policy for clawdult workstation ${name}`,
        Tags: [
          { Key: 'clawdult:managed', Value: 'true' },
          { Key: 'clawdult:agent', Value: name },
        ],
      })
    );

    return policyArn;
  } catch (error) {
    if (error instanceof Error && error.name === 'EntityAlreadyExistsException') {
      return policyArn;
    }
    throw error;
  }
}

async function ensureRole(name: string, client: IAMClient, boundaryArn: string): Promise<string> {
  const roleName = getRoleName(name);

  // EC2 trust policy
  const trustPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {
          Service: 'ec2.amazonaws.com',
        },
        Action: 'sts:AssumeRole',
      },
    ],
  };

  try {
    const response = await client.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
        Description: `IAM role for clawdult workstation ${name}`,
        PermissionsBoundary: boundaryArn,
        Tags: [
          { Key: 'clawdult:managed', Value: 'true' },
          { Key: 'clawdult:agent', Value: name },
        ],
      })
    );

    return response.Role!.Arn!;
  } catch (error) {
    if (error instanceof Error && error.name === 'EntityAlreadyExistsException') {
      // Get existing role ARN
      const getResponse = await client.send(
        new GetRoleCommand({
          RoleName: roleName,
        })
      );
      return getResponse.Role!.Arn!;
    }
    throw error;
  }
}

async function ensureInstanceProfile(name: string, client: IAMClient): Promise<string> {
  const profileName = getProfileName(name);

  try {
    const response = await client.send(
      new CreateInstanceProfileCommand({
        InstanceProfileName: profileName,
        Tags: [
          { Key: 'clawdult:managed', Value: 'true' },
          { Key: 'clawdult:agent', Value: name },
        ],
      })
    );

    return response.InstanceProfile!.Arn!;
  } catch (error) {
    if (error instanceof Error && error.name === 'EntityAlreadyExistsException') {
      const getResponse = await client.send(
        new GetInstanceProfileCommand({
          InstanceProfileName: profileName,
        })
      );
      return getResponse.InstanceProfile!.Arn!;
    }
    throw error;
  }
}

async function attachPoliciesToRole(
  roleName: string,
  policyArns: string[],
  client: IAMClient
): Promise<void> {
  for (const policyArn of policyArns) {
    try {
      await client.send(
        new AttachRolePolicyCommand({
          RoleName: roleName,
          PolicyArn: policyArn,
        })
      );
    } catch (error) {
      // Ignore if already attached
      if (!(error instanceof Error && error.message.includes('already'))) {
        throw error;
      }
    }
  }
}

async function addRoleToInstanceProfile(
  roleName: string,
  profileName: string,
  client: IAMClient
): Promise<void> {
  try {
    await client.send(
      new AddRoleToInstanceProfileCommand({
        RoleName: roleName,
        InstanceProfileName: profileName,
      })
    );
  } catch (error) {
    // LimitExceeded means the profile already has a role attached - verify it's the correct one
    if (error instanceof Error && error.name === 'LimitExceededException') {
      const response = await client.send(
        new GetInstanceProfileCommand({
          InstanceProfileName: profileName,
        })
      );

      const attachedRoles = response.InstanceProfile?.Roles || [];
      if (attachedRoles.length === 0) {
        throw new Error(
          `Instance profile ${profileName} has no roles attached despite LimitExceededException`
        );
      }

      const attachedRoleName = attachedRoles[0].RoleName;
      if (attachedRoleName !== roleName) {
        throw new Error(
          `Instance profile ${profileName} has role '${attachedRoleName}' attached, expected '${roleName}'. ` +
            `Delete the existing role association or use a different workstation name.`
        );
      }

      // Correct role is already attached - idempotent success
      return;
    }
    throw error;
  }
}

async function ensureSageMakerRole(
  name: string,
  client: IAMClient,
  boundaryArn: string
): Promise<string> {
  const roleName = getSageMakerRoleName(name);

  const trustPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {
          Service: 'sagemaker.amazonaws.com',
        },
        Action: 'sts:AssumeRole',
      },
    ],
  };

  // Inline policy: S3 workspace access + CloudWatch Logs
  const sageMakerPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'S3WorkspaceAccess',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
        Resource: ['arn:aws:s3:::clawdult-workspace-*', 'arn:aws:s3:::clawdult-workspace-*/*'],
      },
      {
        Sid: 'CloudWatchLogsAccess',
        Effect: 'Allow',
        Action: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogStreams',
        ],
        Resource: 'arn:aws:logs:*:*:log-group:/aws/sagemaker/*',
      },
    ],
  };

  try {
    const response = await client.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
        Description: `SageMaker execution role for clawdult workstation ${name}`,
        PermissionsBoundary: boundaryArn,
        Tags: [
          { Key: 'clawdult:managed', Value: 'true' },
          { Key: 'clawdult:agent', Value: name },
        ],
      })
    );

    // Attach inline policy for S3/CloudWatch access
    await client.send(
      new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: `${roleName}-policy`,
        PolicyDocument: JSON.stringify(sageMakerPolicy),
      })
    );

    return response.Role!.Arn!;
  } catch (error) {
    if (error instanceof Error && error.name === 'EntityAlreadyExistsException') {
      const getResponse = await client.send(new GetRoleCommand({ RoleName: roleName }));
      return getResponse.Role!.Arn!;
    }
    throw error;
  }
}

async function waitForInstanceProfileReady(
  profileName: string,
  client: IAMClient,
  maxWaitSeconds: number = 30
): Promise<void> {
  const startTime = Date.now();
  const pollInterval = 2000; // 2 seconds

  while (true) {
    try {
      const response = await client.send(
        new GetInstanceProfileCommand({
          InstanceProfileName: profileName,
        })
      );

      // Check if role is attached
      if (response.InstanceProfile?.Roles && response.InstanceProfile.Roles.length > 0) {
        // Wait a bit more for IAM propagation
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return;
      }
    } catch (error) {
      // NoSuchEntityException is transient during eventual consistency - keep polling
      if (!(error instanceof Error && error.name === 'NoSuchEntityException')) {
        throw error;
      }
    }

    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed >= maxWaitSeconds) {
      throw new Error(`Timeout waiting for instance profile ${profileName} to be ready`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

/**
 * Create all IAM resources needed for a workstation.
 * This is idempotent - safe to call multiple times.
 */
export async function ensureIamResources(
  name: string,
  region: string,
  capabilities: CapabilityModule[] = []
): Promise<IamResources> {
  const client = await createIAMClient(region);
  const accountId = await getAccountId(region);

  // Create permission boundary (composed from base + capability overrides)
  const boundaryArn = await ensurePermissionBoundary(name, client, accountId, capabilities);

  // Create agent policy (composed from base + capability modules)
  const policyArn = await ensureAgentPolicy(name, client, accountId, capabilities);

  // Create role with permission boundary
  const roleArn = await ensureRole(name, client, boundaryArn);

  // Create instance profile
  const instanceProfileArn = await ensureInstanceProfile(name, client);

  // Attach policies to role (agent policy + SSM managed policy for Session Manager)
  // Use retry for eventual consistency - role may not be immediately visible
  const roleName = getRoleName(name);
  await retryWithBackoff(() =>
    attachPoliciesToRole(
      roleName,
      [policyArn, 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'],
      client
    )
  );

  // Link role to instance profile
  // Use retry for eventual consistency - role/profile may not be immediately visible
  const profileName = getProfileName(name);
  await retryWithBackoff(() => addRoleToInstanceProfile(roleName, profileName, client));

  // Create extra roles based on capabilities
  const extraRoles: ExtraRoleInfo[] = [];
  for (const extra of getExtraRoles(capabilities)) {
    if (extra.type === 'sagemaker') {
      const sageMakerRoleName = getSageMakerRoleName(name);
      const sageMakerRoleArn = await ensureSageMakerRole(name, client, boundaryArn);
      extraRoles.push({
        roleName: sageMakerRoleName,
        roleArn: sageMakerRoleArn,
        type: 'sagemaker',
      });
    }
  }

  // Wait for IAM propagation
  await waitForInstanceProfileReady(profileName, client);

  return {
    instanceProfileName: profileName,
    instanceProfileArn,
    roleName,
    roleArn,
    policyArn,
    boundaryArn,
    extraRoles,
  };
}

/**
 * Delete all IAM resources for a workstation.
 * Order matters: detach policies, remove role from profile, delete profile, delete role, delete policies.
 *
 * When capabilities are provided, only the relevant extra roles are cleaned up.
 * When omitted (backwards compat for pre-existing workstations), attempts SageMaker cleanup.
 */
export async function deleteIamResources(
  name: string,
  region: string,
  capabilities?: CapabilityModule[]
): Promise<void> {
  const client = await createIAMClient(region);
  const accountId = await getAccountId(region);

  const roleName = getRoleName(name);
  const profileName = getProfileName(name);
  const policyArn = `arn:aws:iam::${accountId}:policy/${getPolicyName(name)}`;
  const boundaryArn = `arn:aws:iam::${accountId}:policy/${getBoundaryName(name)}`;

  // 1. Detach all policies from role
  try {
    const attachedPolicies = await client.send(
      new ListAttachedRolePoliciesCommand({
        RoleName: roleName,
      })
    );

    for (const policy of attachedPolicies.AttachedPolicies || []) {
      if (policy.PolicyArn) {
        await client.send(
          new DetachRolePolicyCommand({
            RoleName: roleName,
            PolicyArn: policy.PolicyArn,
          })
        );
      }
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === 'NoSuchEntityException')) {
      throw error;
    }
  }

  // 2. Remove role from instance profile
  try {
    await client.send(
      new RemoveRoleFromInstanceProfileCommand({
        RoleName: roleName,
        InstanceProfileName: profileName,
      })
    );
  } catch (error) {
    if (!(error instanceof Error && error.name === 'NoSuchEntityException')) {
      throw error;
    }
  }

  // 3. Delete instance profile
  try {
    await client.send(
      new DeleteInstanceProfileCommand({
        InstanceProfileName: profileName,
      })
    );
  } catch (error) {
    if (!(error instanceof Error && error.name === 'NoSuchEntityException')) {
      throw error;
    }
  }

  // 4. Delete role
  try {
    await client.send(
      new DeleteRoleCommand({
        RoleName: roleName,
      })
    );
  } catch (error) {
    if (!(error instanceof Error && error.name === 'NoSuchEntityException')) {
      throw error;
    }
  }

  // 5. Delete agent policy
  try {
    await client.send(
      new DeletePolicyCommand({
        PolicyArn: policyArn,
      })
    );
  } catch (error) {
    if (!(error instanceof Error && error.name === 'NoSuchEntityException')) {
      throw error;
    }
  }

  // 6. Delete extra roles based on capabilities
  // When capabilities not provided, attempt SageMaker cleanup for backwards compatibility
  const shouldCleanupSageMaker = capabilities === undefined || capabilities.includes('sagemaker');

  if (shouldCleanupSageMaker) {
    const sageMakerRoleName = getSageMakerRoleName(name);
    try {
      await client.send(
        new DeleteRolePolicyCommand({
          RoleName: sageMakerRoleName,
          PolicyName: `${sageMakerRoleName}-policy`,
        })
      );
    } catch (error) {
      if (!(error instanceof Error && error.name === 'NoSuchEntityException')) {
        throw error;
      }
    }

    try {
      await client.send(
        new DeleteRoleCommand({
          RoleName: sageMakerRoleName,
        })
      );
    } catch (error) {
      if (!(error instanceof Error && error.name === 'NoSuchEntityException')) {
        throw error;
      }
    }
  }

  // 6b. Delete custom policy (if any)
  const customPolicyArn = `arn:aws:iam::${accountId}:policy/${getCustomPolicyName(name)}`;
  try {
    await client.send(
      new DeletePolicyCommand({
        PolicyArn: customPolicyArn,
      })
    );
  } catch (error) {
    if (!(error instanceof Error && error.name === 'NoSuchEntityException')) {
      throw error;
    }
  }

  // 7. Delete permission boundary
  try {
    await client.send(
      new DeletePolicyCommand({
        PolicyArn: boundaryArn,
      })
    );
  } catch (error) {
    if (!(error instanceof Error && error.name === 'NoSuchEntityException')) {
      throw error;
    }
  }
}

/**
 * Attach custom IAM permissions to a workstation's role.
 * Idempotent: if the policy already exists, it is deleted and recreated.
 */
export async function attachCustomPermissions(
  workstationName: string,
  region: string,
  statements: IamStatement[]
): Promise<void> {
  const client = await createIAMClient(region);
  const accountId = await getAccountId(region);
  const customPolicyName = getCustomPolicyName(workstationName);
  const customPolicyArn = `arn:aws:iam::${accountId}:policy/${customPolicyName}`;
  const roleName = getRoleName(workstationName);

  const policyDocument = JSON.stringify({
    Version: '2012-10-17',
    Statement: statements,
  });

  // Delete existing policy if present (handles updates)
  try {
    await client.send(
      new DetachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: customPolicyArn,
      })
    );
  } catch (error) {
    if (!(error instanceof Error && error.name === 'NoSuchEntityException')) {
      throw error;
    }
  }

  try {
    // Delete all non-default policy versions before deleting the policy
    const versions = await client.send(
      new ListPolicyVersionsCommand({ PolicyArn: customPolicyArn })
    );
    for (const version of versions.Versions || []) {
      if (!version.IsDefaultVersion) {
        await client.send(
          new DeletePolicyVersionCommand({
            PolicyArn: customPolicyArn,
            VersionId: version.VersionId!,
          })
        );
      }
    }
    await client.send(new DeletePolicyCommand({ PolicyArn: customPolicyArn }));
  } catch (error) {
    if (!(error instanceof Error && error.name === 'NoSuchEntityException')) {
      throw error;
    }
  }

  // Create the policy
  await client.send(
    new CreatePolicyCommand({
      PolicyName: customPolicyName,
      PolicyDocument: policyDocument,
      Description: `Custom permissions for clawdult workstation ${workstationName}`,
      Tags: [
        { Key: 'clawdult:managed', Value: 'true' },
        { Key: 'clawdult:agent', Value: workstationName },
      ],
    })
  );

  // Attach to role
  await client.send(
    new AttachRolePolicyCommand({
      RoleName: roleName,
      PolicyArn: customPolicyArn,
    })
  );
}

/**
 * Detach and delete custom IAM permissions from a workstation's role.
 * Idempotent: ignores NoSuchEntity errors.
 */
export async function detachCustomPermissions(
  workstationName: string,
  region: string
): Promise<void> {
  const client = await createIAMClient(region);
  const accountId = await getAccountId(region);
  const customPolicyName = getCustomPolicyName(workstationName);
  const customPolicyArn = `arn:aws:iam::${accountId}:policy/${customPolicyName}`;
  const roleName = getRoleName(workstationName);

  // Detach from role
  try {
    await client.send(
      new DetachRolePolicyCommand({
        RoleName: roleName,
        PolicyArn: customPolicyArn,
      })
    );
  } catch (error) {
    if (!(error instanceof Error && error.name === 'NoSuchEntityException')) {
      throw error;
    }
  }

  // Delete policy
  try {
    await client.send(new DeletePolicyCommand({ PolicyArn: customPolicyArn }));
  } catch (error) {
    if (!(error instanceof Error && error.name === 'NoSuchEntityException')) {
      throw error;
    }
  }
}
