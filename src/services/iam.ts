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
} from '@aws-sdk/client-iam';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAWSClientConfig } from './aws-client.js';
import { retryWithBackoff } from './aws-retry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface IamResources {
  instanceProfileName: string;
  instanceProfileArn: string;
  roleName: string;
  roleArn: string;
  policyArn: string;
  boundaryArn: string;
  sageMakerRoleName: string;
  sageMakerRoleArn: string;
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

async function createIAMClient(region: string): Promise<IAMClient> {
  return new IAMClient(await getAWSClientConfig(region));
}

async function getAccountId(region: string): Promise<string> {
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const stsClient = new STSClient(await getAWSClientConfig(region));
  const identity = await stsClient.send(new GetCallerIdentityCommand({}));
  return identity.Account!;
}

function getPolicyPath(filename: string): string {
  const projectRoot = path.resolve(__dirname, '..', '..');
  return path.join(projectRoot, 'policies', filename);
}

async function loadPolicyDocument(filename: string): Promise<string> {
  const policyPath = getPolicyPath(filename);
  return fs.readFile(policyPath, 'utf-8');
}

async function ensurePermissionBoundary(
  name: string,
  region: string,
  client: IAMClient,
  accountId: string
): Promise<string> {
  const boundaryName = getBoundaryName(name);
  const boundaryArn = `arn:aws:iam::${accountId}:policy/${boundaryName}`;

  try {
    const policyDocument = await loadPolicyDocument('spending-limit-boundary.json');

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
  region: string,
  client: IAMClient,
  accountId: string
): Promise<string> {
  const policyName = getPolicyName(name);
  const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;

  try {
    let policyDocument = await loadPolicyDocument('agent-base-policy.json');

    // Replace the placeholder with the literal agent name
    // The policy uses ${aws:PrincipalTag/clawdult:agent} which won't work for instance profiles
    // We need to replace it with the actual agent name
    policyDocument = policyDocument.replace(/\$\{aws:PrincipalTag\/clawdult:agent\}/g, name);

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

async function ensureRole(
  name: string,
  region: string,
  client: IAMClient,
  boundaryArn: string
): Promise<string> {
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

async function ensureInstanceProfile(
  name: string,
  region: string,
  client: IAMClient
): Promise<string> {
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
export async function ensureIamResources(name: string, region: string): Promise<IamResources> {
  const client = await createIAMClient(region);
  const accountId = await getAccountId(region);

  // Create permission boundary
  const boundaryArn = await ensurePermissionBoundary(name, region, client, accountId);

  // Create agent policy
  const policyArn = await ensureAgentPolicy(name, region, client, accountId);

  // Create role with permission boundary
  const roleArn = await ensureRole(name, region, client, boundaryArn);

  // Create instance profile
  const instanceProfileArn = await ensureInstanceProfile(name, region, client);

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

  // Create SageMaker execution role (for GPU training job dispatch)
  const sageMakerRoleName = getSageMakerRoleName(name);
  const sageMakerRoleArn = await ensureSageMakerRole(name, client, boundaryArn);

  // Wait for IAM propagation
  await waitForInstanceProfileReady(profileName, client);

  return {
    instanceProfileName: profileName,
    instanceProfileArn,
    roleName,
    roleArn,
    policyArn,
    boundaryArn,
    sageMakerRoleName,
    sageMakerRoleArn,
  };
}

/**
 * Delete all IAM resources for a workstation.
 * Order matters: detach policies, remove role from profile, delete profile, delete role, delete policies.
 */
export async function deleteIamResources(name: string, region: string): Promise<void> {
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

  // 6. Delete SageMaker execution role (inline policy + role)
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
