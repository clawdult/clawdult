import {
  IAMClient,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  CreateUserCommand,
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
  GetUserCommand,
  ListAccessKeysCommand,
  DeleteAccessKeyCommand,
  ListAttachedUserPoliciesCommand,
  ListPolicyVersionsCommand,
  DeletePolicyVersionCommand,
} from '@aws-sdk/client-iam';
import { POLICY_NAME, USER_NAME, loadProvisionerPolicy } from './constants.js';
import type { BootstrapResult } from './constants.js';
import { getCredentialsFromProfile, getAccountId } from './credentials.js';

/**
 * Create the ClawdultProvisioner IAM policy
 */
export async function createProvisionerPolicy(profile?: string): Promise<BootstrapResult> {
  try {
    const clientConfig = profile
      ? {
          credentials: await getCredentialsFromProfile(profile),
        }
      : {};

    const client = new IAMClient(clientConfig);
    const policy = await loadProvisionerPolicy();

    const command = new CreatePolicyCommand({
      PolicyName: POLICY_NAME,
      PolicyDocument: JSON.stringify(policy),
      Description: 'Permissions for Clawdult provisioner to manage agent workstations',
    });

    const response = await client.send(command);

    return {
      success: true,
      policyArn: response.Policy?.Arn,
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'EntityAlreadyExistsException') {
      // Policy already exists, get its ARN
      const accountId = await getAccountId(profile);
      if (accountId) {
        return {
          success: true,
          policyArn: `arn:aws:iam::${accountId}:policy/${POLICY_NAME}`,
        };
      }
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Update the ClawdultProvisioner IAM policy with a new version
 */
export async function updateProvisionerPolicy(
  policyArn: string,
  profile?: string
): Promise<BootstrapResult> {
  try {
    const clientConfig = profile
      ? {
          credentials: await getCredentialsFromProfile(profile),
        }
      : {};

    const client = new IAMClient(clientConfig);
    const policy = await loadProvisionerPolicy();

    // List existing versions to check if we need to delete one
    const versionsResponse = await client.send(
      new ListPolicyVersionsCommand({
        PolicyArn: policyArn,
      })
    );

    const versions = versionsResponse.Versions || [];

    // AWS allows max 5 versions. Delete oldest non-default version if at limit.
    if (versions.length >= 5) {
      const nonDefaultVersions = versions
        .filter((v) => !v.IsDefaultVersion)
        .sort((a, b) => {
          const dateA = a.CreateDate?.getTime() || 0;
          const dateB = b.CreateDate?.getTime() || 0;
          return dateA - dateB;
        });

      if (nonDefaultVersions.length > 0) {
        await client.send(
          new DeletePolicyVersionCommand({
            PolicyArn: policyArn,
            VersionId: nonDefaultVersions[0].VersionId,
          })
        );
      }
    }

    // Create new policy version and set as default
    await client.send(
      new CreatePolicyVersionCommand({
        PolicyArn: policyArn,
        PolicyDocument: JSON.stringify(policy),
        SetAsDefault: true,
      })
    );

    return {
      success: true,
      policyArn,
    };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if the ClawdultProvisioner policy already exists
 */
export async function checkPolicyExists(profile?: string): Promise<string | null> {
  try {
    const accountId = await getAccountId(profile);
    if (!accountId) return null;

    const clientConfig = profile
      ? {
          credentials: await getCredentialsFromProfile(profile),
        }
      : {};

    const client = new IAMClient(clientConfig);
    const policyArn = `arn:aws:iam::${accountId}:policy/${POLICY_NAME}`;

    await client.send(new GetPolicyCommand({ PolicyArn: policyArn }));
    return policyArn;
  } catch {
    return null;
  }
}

/**
 * Fetch the AWS policy document for a given policy ARN
 */
export async function getAwsPolicyDocument(
  policyArn: string,
  profile?: string
): Promise<object | null> {
  try {
    const clientConfig = profile
      ? {
          credentials: await getCredentialsFromProfile(profile),
        }
      : {};

    const client = new IAMClient(clientConfig);

    // Get the default version ID
    const policyResponse = await client.send(new GetPolicyCommand({ PolicyArn: policyArn }));
    const defaultVersionId = policyResponse.Policy?.DefaultVersionId;
    if (!defaultVersionId) return null;

    // Fetch the policy document
    const versionResponse = await client.send(
      new GetPolicyVersionCommand({
        PolicyArn: policyArn,
        VersionId: defaultVersionId,
      })
    );

    const document = versionResponse.PolicyVersion?.Document;
    if (!document) return null;

    // Document is URL-encoded, decode and parse
    return JSON.parse(decodeURIComponent(document));
  } catch {
    return null;
  }
}

/**
 * Compare two policy objects for equality (normalizing JSON formatting)
 */
export function comparePolicies(localPolicy: object, awsPolicy: object): { identical: boolean } {
  // Sort keys recursively for consistent comparison
  const sortKeys = (obj: unknown): unknown => {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(sortKeys);
    return Object.keys(obj as Record<string, unknown>)
      .sort()
      .reduce(
        (result, key) => {
          result[key] = sortKeys((obj as Record<string, unknown>)[key]);
          return result;
        },
        {} as Record<string, unknown>
      );
  };

  const sortedLocal = JSON.stringify(sortKeys(localPolicy));
  const sortedAws = JSON.stringify(sortKeys(awsPolicy));

  return { identical: sortedLocal === sortedAws };
}

/**
 * Check if the clawdult-local user already exists
 */
export async function checkUserExists(profile?: string): Promise<string | null> {
  try {
    const clientConfig = profile
      ? {
          credentials: await getCredentialsFromProfile(profile),
        }
      : {};

    const client = new IAMClient(clientConfig);
    const response = await client.send(new GetUserCommand({ UserName: USER_NAME }));
    return response.User?.Arn ?? null;
  } catch {
    return null;
  }
}

/**
 * Create the clawdult-local IAM user
 */
export async function createClawdultUser(profile?: string): Promise<BootstrapResult> {
  try {
    const clientConfig = profile
      ? {
          credentials: await getCredentialsFromProfile(profile),
        }
      : {};

    const client = new IAMClient(clientConfig);

    const command = new CreateUserCommand({
      UserName: USER_NAME,
      Tags: [
        { Key: 'clawdult:managed', Value: 'true' },
        { Key: 'Purpose', Value: 'Clawdult local provisioner' },
      ],
    });

    const response = await client.send(command);

    return {
      success: true,
      userArn: response.User?.Arn,
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'EntityAlreadyExistsException') {
      const userArn = await checkUserExists(profile);
      return {
        success: true,
        userArn: userArn ?? undefined,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Attach policy to user
 */
export async function attachPolicyToUser(
  policyArn: string,
  profile?: string
): Promise<BootstrapResult> {
  try {
    const clientConfig = profile
      ? {
          credentials: await getCredentialsFromProfile(profile),
        }
      : {};

    const client = new IAMClient(clientConfig);

    // Check if already attached
    const listResponse = await client.send(
      new ListAttachedUserPoliciesCommand({
        UserName: USER_NAME,
      })
    );

    const alreadyAttached = listResponse.AttachedPolicies?.some((p) => p.PolicyArn === policyArn);

    if (alreadyAttached) {
      return { success: true };
    }

    await client.send(
      new AttachUserPolicyCommand({
        UserName: USER_NAME,
        PolicyArn: policyArn,
      })
    );

    return { success: true };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get existing access keys for the user
 */
export async function getExistingAccessKeys(profile?: string): Promise<string[]> {
  try {
    const clientConfig = profile
      ? {
          credentials: await getCredentialsFromProfile(profile),
        }
      : {};

    const client = new IAMClient(clientConfig);
    const response = await client.send(
      new ListAccessKeysCommand({
        UserName: USER_NAME,
      })
    );

    return response.AccessKeyMetadata?.map((k) => k.AccessKeyId ?? '').filter(Boolean) ?? [];
  } catch {
    return [];
  }
}

/**
 * Delete an access key
 */
export async function deleteAccessKey(accessKeyId: string, profile?: string): Promise<boolean> {
  try {
    const clientConfig = profile
      ? {
          credentials: await getCredentialsFromProfile(profile),
        }
      : {};

    const client = new IAMClient(clientConfig);
    await client.send(
      new DeleteAccessKeyCommand({
        UserName: USER_NAME,
        AccessKeyId: accessKeyId,
      })
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Create access keys for the user
 */
export async function createAccessKeys(profile?: string): Promise<BootstrapResult> {
  try {
    const clientConfig = profile
      ? {
          credentials: await getCredentialsFromProfile(profile),
        }
      : {};

    const client = new IAMClient(clientConfig);

    const response = await client.send(
      new CreateAccessKeyCommand({
        UserName: USER_NAME,
      })
    );

    if (response.AccessKey?.AccessKeyId && response.AccessKey?.SecretAccessKey) {
      return {
        success: true,
        credentials: {
          accessKeyId: response.AccessKey.AccessKeyId,
          secretAccessKey: response.AccessKey.SecretAccessKey,
        },
      };
    }

    return {
      success: false,
      error: 'Failed to create access keys',
    };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'LimitExceededException') {
      return {
        success: false,
        error: 'Access key limit reached (max 2). Delete an existing key first.',
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
