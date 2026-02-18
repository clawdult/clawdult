import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { IAMClient, GetPolicyCommand } from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { EC2Client, DescribeAvailabilityZonesCommand } from '@aws-sdk/client-ec2';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AwsCredentials, CallerIdentity } from './constants.js';
import { DEFAULT_PROFILE } from './constants.js';

export interface ProfileConfig {
  credentials: AwsCredentials;
  region: string;
}

/**
 * Get region for a profile with fallback chain:
 * 1. Profile-specific region from config
 * 2. AWS_DEFAULT_REGION env var
 * 3. Default to us-east-1
 */
async function getProfileRegion(profile: string): Promise<string> {
  // Try profile-specific region from AWS config
  const regionResult = spawnSync('aws', ['configure', 'get', 'region', '--profile', profile], {
    encoding: 'utf-8',
  });

  if (regionResult.status === 0 && regionResult.stdout.trim()) {
    return regionResult.stdout.trim();
  }

  // Fall back to env var or default
  return process.env.AWS_DEFAULT_REGION || 'us-east-1';
}

function resolveAwsSharedFilePath(envValue: string | undefined, filename: string): string {
  if (envValue && envValue.trim()) {
    return envValue.trim();
  }
  return path.join(os.homedir(), '.aws', filename);
}

function extractProfileNameFromHeader(
  header: string,
  source: 'config' | 'credentials'
): string | null {
  const normalized = header.trim();
  if (!normalized) {
    return null;
  }

  if (normalized === 'default') {
    return 'default';
  }

  if (normalized.startsWith('profile ')) {
    const name = normalized.slice('profile '.length).trim();
    return name || null;
  }

  if (source === 'credentials') {
    if (normalized.startsWith('sso-session ') || normalized.startsWith('services ')) {
      return null;
    }
    return normalized;
  }

  return null;
}

async function addProfilesFromFile(
  filePath: string,
  source: 'config' | 'credentials',
  profiles: Set<string>
): Promise<void> {
  try {
    const contents = await fs.readFile(filePath, 'utf-8');
    const lines = contents.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
        continue;
      }

      const match = trimmed.match(/^\[([^\]]+)]/);
      if (!match) {
        continue;
      }

      const profileName = extractProfileNameFromHeader(match[1], source);
      if (profileName) {
        profiles.add(profileName);
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return;
    }
    throw new Error(
      `Failed to read AWS ${source} file at ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function getConfiguredProfileNames(): Promise<Set<string>> {
  const profiles = new Set<string>();
  const configPath = resolveAwsSharedFilePath(process.env.AWS_CONFIG_FILE, 'config');
  const credentialsPath = resolveAwsSharedFilePath(
    process.env.AWS_SHARED_CREDENTIALS_FILE,
    'credentials'
  );

  await addProfilesFromFile(configPath, 'config', profiles);
  await addProfilesFromFile(credentialsPath, 'credentials', profiles);

  return profiles;
}

/**
 * Get an actionable error message for credential errors
 */
function getCredentialErrorMessage(error: unknown, profile: string): string {
  if (!(error instanceof Error)) {
    return `Unknown error with profile '${profile}'`;
  }

  const message = error.message.toLowerCase();
  const name = error.name;

  // SSO token expired
  if (message.includes('sso') && (message.includes('expired') || message.includes('token'))) {
    return `SSO token expired for profile '${profile}'. Run: aws sso login --profile ${profile}`;
  }

  // Profile not found
  if (
    name === 'CredentialsProviderError' ||
    message.includes('could not be found') ||
    message.includes('profile')
  ) {
    return `AWS profile '${profile}' not found. Check ~/.aws/config and ~/.aws/credentials`;
  }

  // Invalid credentials
  if (
    name === 'InvalidClientTokenId' ||
    message.includes('security token') ||
    message.includes('invalid')
  ) {
    return `Credentials in profile '${profile}' are invalid or expired`;
  }

  // Access denied
  if (name === 'AccessDenied' || message.includes('access denied')) {
    return `Profile '${profile}' lacks required permissions`;
  }

  return `Credential error for profile '${profile}': ${error.message}`;
}

/**
 * Get credentials and region from AWS profile using SDK credential provider
 * Works with all profile types: static credentials, SSO, role assumption, credential_process
 */
export async function getProfileConfig(profile: string): Promise<ProfileConfig | undefined> {
  try {
    const region = await getProfileRegion(profile);
    const credentialProvider = fromNodeProviderChain({ profile });
    const credentials = await credentialProvider();

    return {
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      },
      region,
    };
  } catch {
    return undefined;
  }
}

/**
 * Get credentials from AWS profile (legacy, use getProfileConfig instead)
 */
export async function getCredentialsFromProfile(
  profile: string
): Promise<AwsCredentials | undefined> {
  const config = await getProfileConfig(profile);
  return config?.credentials;
}

/**
 * Check if AWS credentials are configured for a profile
 */
export async function checkAwsAuth(profile?: string): Promise<CallerIdentity | null> {
  try {
    let clientConfig: Record<string, unknown> = { region: 'us-east-1' };
    if (profile) {
      const config = await getProfileConfig(profile);
      if (!config) {
        return null;
      }
      clientConfig = {
        credentials: config.credentials,
        region: config.region,
      };
    }

    const client = new STSClient(clientConfig);
    const command = new GetCallerIdentityCommand({});
    const response = await client.send(command);

    if (response.UserId && response.Account && response.Arn) {
      return {
        userId: response.UserId,
        account: response.Account,
        arn: response.Arn,
      };
    }
    return null;
  } catch (error) {
    console.error(
      'clawdult: AWS auth check failed:',
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}

/**
 * Check if user has IAM permissions to create resources
 */
export async function checkIamPermissions(profile?: string): Promise<boolean> {
  try {
    let clientConfig: Record<string, unknown> = { region: 'us-east-1' };
    if (profile) {
      const config = await getProfileConfig(profile);
      if (!config) {
        return false;
      }
      clientConfig = {
        credentials: config.credentials,
        region: config.region,
      };
    }

    const client = new IAMClient(clientConfig);

    // Try to list policies - if this works, we likely have IAM access
    const command = new GetPolicyCommand({
      PolicyArn: 'arn:aws:iam::aws:policy/IAMReadOnlyAccess',
    });

    await client.send(command);
    return true;
  } catch (error: unknown) {
    // AccessDenied means we don't have permissions
    if (error instanceof Error && error.name === 'AccessDeniedException') {
      return false;
    }
    // Other errors might still indicate we have some access
    return false;
  }
}

/**
 * Check if a profile exists in local AWS config/credentials files
 */
export async function checkProfileExists(profileName: string): Promise<boolean> {
  const profiles = await getConfiguredProfileNames();
  return profiles.has(profileName);
}

/**
 * Get the account ID for building policy ARNs
 */
export async function getAccountId(profile?: string): Promise<string | null> {
  const identity = await checkAwsAuth(profile);
  return identity?.account ?? null;
}

/**
 * Check if provisioner credentials are configured and working
 * Returns an object with status and details about what's missing
 * Works with all profile types: static credentials, SSO, role assumption, credential_process
 */
export async function checkProvisionerCredentials(profileName: string = DEFAULT_PROFILE): Promise<{
  configured: boolean;
  profileExists: boolean;
  credentialsValid: boolean;
  ec2Access: boolean;
  message: string;
}> {
  const result = {
    configured: false,
    profileExists: false,
    credentialsValid: false,
    ec2Access: false,
    message: '',
  };

  const region = await getProfileRegion(profileName);
  const credentialProvider = fromNodeProviderChain({ profile: profileName });

  // Verify credentials work with STS
  try {
    const stsClient = new STSClient({
      credentials: credentialProvider,
      region,
    });
    await stsClient.send(new GetCallerIdentityCommand({}));
    result.profileExists = true;
    result.credentialsValid = true;
  } catch (error) {
    result.message = getCredentialErrorMessage(error, profileName);
    return result;
  }

  // Verify EC2 access (required for provisioning)
  try {
    const ec2Client = new EC2Client({
      credentials: credentialProvider,
      region,
    });
    await ec2Client.send(new DescribeAvailabilityZonesCommand({}));
    result.ec2Access = true;
  } catch {
    result.message = `Profile '${profileName}' lacks EC2 permissions needed for provisioning`;
    return result;
  }

  result.configured = true;
  result.message = 'Credentials configured and verified';
  return result;
}

/**
 * Verify credentials work by testing various permissions
 */
export async function verifyCredentials(profileName: string = DEFAULT_PROFILE): Promise<{
  identity: boolean;
  ec2Describe: boolean;
  iamList: boolean;
}> {
  const results = {
    identity: false,
    ec2Describe: false,
    iamList: false,
  };

  const config = await getProfileConfig(profileName);
  if (!config) return results;

  const clientConfig = {
    credentials: config.credentials,
    region: config.region,
  };

  // Test STS identity
  try {
    const stsClient = new STSClient(clientConfig);
    await stsClient.send(new GetCallerIdentityCommand({}));
    results.identity = true;
  } catch {
    // Failed
  }

  // Test EC2 describe
  try {
    const ec2Client = new EC2Client(clientConfig);
    await ec2Client.send(new DescribeAvailabilityZonesCommand({}));
    results.ec2Describe = true;
  } catch {
    // Failed
  }

  // Test IAM list
  try {
    const iamClient = new IAMClient(clientConfig);
    await iamClient.send(
      new GetPolicyCommand({
        PolicyArn: 'arn:aws:iam::aws:policy/IAMReadOnlyAccess',
      })
    );
    results.iamList = true;
  } catch (error: unknown) {
    // AccessDenied is expected with scoped permissions - that's OK
    if (error instanceof Error && error.name === 'AccessDeniedException') {
      results.iamList = true;
    }
    // Other errors (network, auth, etc.) leave iamList = false
  }

  return results;
}

/**
 * Configure AWS CLI profile with credentials
 */
export function configureAwsProfile(
  credentials: AwsCredentials,
  profileName: string = DEFAULT_PROFILE,
  region?: string
): boolean {
  try {
    spawnSync(
      'aws',
      ['configure', 'set', 'aws_access_key_id', credentials.accessKeyId, '--profile', profileName],
      {
        encoding: 'utf-8',
      }
    );

    spawnSync(
      'aws',
      [
        'configure',
        'set',
        'aws_secret_access_key',
        credentials.secretAccessKey,
        '--profile',
        profileName,
      ],
      {
        encoding: 'utf-8',
      }
    );

    if (region) {
      spawnSync('aws', ['configure', 'set', 'region', region, '--profile', profileName], {
        encoding: 'utf-8',
      });
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Helper to get credentials from profile (exported for reuse)
 */
export async function getProfileCredentials(profile: string): Promise<AwsCredentials | undefined> {
  return getCredentialsFromProfile(profile);
}
