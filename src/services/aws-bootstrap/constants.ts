import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface CallerIdentity {
  userId: string;
  account: string;
  arn: string;
}

export interface BootstrapResult {
  success: boolean;
  error?: string;
  policyArn?: string;
  userArn?: string;
  credentials?: AwsCredentials;
}

export const POLICY_NAME = 'ClawdultProvisioner';
export const USER_NAME = 'clawdult-local';
export const DEFAULT_PROFILE = 'clawdult';

/**
 * Get the path to the provisioner policy JSON file
 */
export function getProvisionerPolicyPath(): string {
  // In development, go up from dist/services/aws-bootstrap to project root
  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  return path.join(projectRoot, 'policies', 'clawdult-provisioner.json');
}

/**
 * Load the provisioner policy document
 */
export async function loadProvisionerPolicy(): Promise<object> {
  const policyPath = getProvisionerPolicyPath();
  const content = await fs.readFile(policyPath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Get AWS console URLs for manual setup
 */
export function getConsoleUrls() {
  return {
    createPolicy: 'https://console.aws.amazon.com/iam/home#/policies$new?step=edit',
    editPolicy: (policyArn: string) =>
      `https://console.aws.amazon.com/iam/home#/policies/details/${encodeURIComponent(policyArn)}`,
    createUser: 'https://console.aws.amazon.com/iam/home#/users$new?step=details',
    listUsers: 'https://console.aws.amazon.com/iam/home#/users',
    securityCredentials: (username: string) =>
      `https://console.aws.amazon.com/iam/home#/users/details/${username}?section=security_credentials`,
  };
}

/**
 * Get the default profile name
 */
export function getDefaultProfileName(): string {
  return DEFAULT_PROFILE;
}

/**
 * Get the IAM user name
 */
export function getIamUserName(): string {
  return USER_NAME;
}

/**
 * Get the policy name
 */
export function getPolicyName(): string {
  return POLICY_NAME;
}
