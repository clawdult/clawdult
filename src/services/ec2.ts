import {
  EC2Client,
  RunInstancesCommand,
  DescribeInstancesCommand,
  DescribeImagesCommand,
  TerminateInstancesCommand,
  StopInstancesCommand,
  StartInstancesCommand,
  ModifyInstanceAttributeCommand,
  CreateImageCommand,
  DeregisterImageCommand,
  CopyImageCommand,
  DescribeVpcsCommand,
  DescribeSecurityGroupsCommand,
  CreateSecurityGroupCommand,
  AuthorizeSecurityGroupIngressCommand,
  CreateKeyPairCommand,
  DescribeKeyPairsCommand,
  CreateTagsCommand,
  type RunInstancesCommandInput,
  type _InstanceType,
  type Instance,
} from '@aws-sdk/client-ec2';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { getAWSClientConfig } from './aws-client.js';

export interface LaunchOptions {
  name: string;
  instanceType: string;
  region: string;
  volumeSize: number;
  subnetId?: string;
  securityGroupIds?: string[];
  iamInstanceProfile?: string;
  keyName?: string;
  amiId?: string;
  // Metadata tags
  keyProfileName?: string;
  githubAgentUsername?: string;
}

export interface ManagedInstance {
  // AWS fields
  instanceId: string;
  state: 'pending' | 'running' | 'shutting-down' | 'terminated' | 'stopping' | 'stopped';
  publicIp?: string;
  privateIp?: string;
  launchTime?: Date;
  instanceType: string;
  region: string;
  // Metadata from tags
  name: string;
  keyProfileName?: string;
  githubAgentUsername?: string;
}

export interface LaunchResult {
  instanceId: string;
  state: string;
}

export interface InstanceStatus {
  instanceId: string;
  state: 'pending' | 'running' | 'shutting-down' | 'terminated' | 'stopping' | 'stopped';
  stateReason?: string;
  publicIpAddress?: string;
  privateIpAddress?: string;
  launchTime?: Date;
}

async function createEC2Client(region: string): Promise<EC2Client> {
  return new EC2Client(await getAWSClientConfig(region));
}

/**
 * Get the latest Clawdult AMI built by setup-admin.
 * Returns null if no AMI exists.
 */
export async function getLatestClawdultAmi(region: string): Promise<string | null> {
  const client = await createEC2Client(region);

  const response = await client.send(
    new DescribeImagesCommand({
      Owners: ['self'],
      Filters: [
        { Name: 'name', Values: ['clawdult-*'] },
        { Name: 'state', Values: ['available'] },
      ],
    })
  );

  if (!response.Images || response.Images.length === 0) {
    return null;
  }

  // Sort by creation date descending to get the latest
  const sorted = response.Images.sort((a, b) => {
    const dateA = new Date(a.CreationDate || 0);
    const dateB = new Date(b.CreationDate || 0);
    return dateB.getTime() - dateA.getTime();
  });

  return sorted[0].ImageId!;
}

function getDefaultUserData(name: string): string {
  const script = `#!/bin/bash
set -eo pipefail

CLAWDULT_BASE="/opt/clawdult"
LOG_FILE="\${CLAWDULT_BASE}/logs/user-data.log"

log() {
    echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE"
}

# Create clawdult directory structure
mkdir -p \${CLAWDULT_BASE}/{bin,config,logs/{agent,audit,cli},secrets,workspace/projects,tools,openclaw/data}

# Set permissions
chmod 700 \${CLAWDULT_BASE}/secrets

log "Clawdult workstation ${name} user-data starting"

# Run OpenClaw bootstrap if script exists (baked into AMI)
if [[ -x "\${CLAWDULT_BASE}/bin/bootstrap-openclaw" ]]; then
    log "Running OpenClaw bootstrap..."
    if \${CLAWDULT_BASE}/bin/bootstrap-openclaw 2>&1 | tee -a "$LOG_FILE"; then
        log "OpenClaw bootstrap completed successfully"
    else
        log "ERROR: OpenClaw bootstrap failed"
        exit 1
    fi
else
    log "No bootstrap-openclaw script found, skipping"
fi

# Fallback readiness signal (bootstrap-openclaw creates .ready earlier, before npm updates)
touch \${CLAWDULT_BASE}/.ready

log "Clawdult workstation ${name} initialized"
`;
  return Buffer.from(script).toString('base64');
}

export async function launchInstance(options: LaunchOptions): Promise<LaunchResult> {
  const client = await createEC2Client(options.region);

  // Use provided AMI (for clone/restore) or get the latest Clawdult AMI
  const amiId = options.amiId ?? (await getLatestClawdultAmi(options.region));
  if (!amiId) {
    throw new Error('No Clawdult AMI found. Run "clawdult setup-admin" to build one first.');
  }

  const runParams: RunInstancesCommandInput = {
    ImageId: amiId,
    InstanceType: options.instanceType as _InstanceType,
    MinCount: 1,
    MaxCount: 1,
    UserData: getDefaultUserData(options.name),
    BlockDeviceMappings: [
      {
        DeviceName: '/dev/sda1',
        Ebs: {
          VolumeSize: options.volumeSize,
          VolumeType: 'gp3',
          Encrypted: true,
          DeleteOnTermination: true,
        },
      },
    ],
    MetadataOptions: {
      HttpEndpoint: 'enabled',
      HttpTokens: 'required', // IMDSv2
      InstanceMetadataTags: 'enabled',
    },
    TagSpecifications: [
      {
        ResourceType: 'instance',
        Tags: [
          { Key: 'Name', Value: `clawdult-${options.name}` },
          { Key: 'clawdult:agent', Value: options.name },
          { Key: 'clawdult:managed', Value: 'true' },
          ...(options.keyProfileName
            ? [{ Key: 'clawdult:keyProfileName', Value: options.keyProfileName }]
            : []),
          ...(options.githubAgentUsername
            ? [{ Key: 'clawdult:githubAgentUsername', Value: options.githubAgentUsername }]
            : []),
        ],
      },
      {
        ResourceType: 'volume',
        Tags: [
          { Key: 'Name', Value: `clawdult-${options.name}-root` },
          { Key: 'clawdult:agent', Value: options.name },
          { Key: 'clawdult:managed', Value: 'true' },
        ],
      },
    ],
  };

  // Add optional parameters
  if (options.subnetId) {
    runParams.SubnetId = options.subnetId;
  }
  if (options.securityGroupIds && options.securityGroupIds.length > 0) {
    runParams.SecurityGroupIds = options.securityGroupIds;
  }
  if (options.iamInstanceProfile) {
    runParams.IamInstanceProfile = { Name: options.iamInstanceProfile };
  }
  if (options.keyName) {
    runParams.KeyName = options.keyName;
  }

  // Retry on IAM eventual consistency errors
  // IAM is global but propagation can take time; EC2 may not see a just-created instance profile
  let response;
  const maxRetries = 5;
  const retryDelay = 5000; // 5 seconds

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      response = await client.send(new RunInstancesCommand(runParams));
      break;
    } catch (error) {
      const isIamError =
        error instanceof Error &&
        (error.message.includes('Invalid IAM Instance Profile') ||
          error.message.includes('iamInstanceProfile.name is invalid'));

      if (isIamError && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        continue;
      }
      throw error;
    }
  }

  if (!response?.Instances || response.Instances.length === 0) {
    throw new Error('Failed to launch instance: no instances returned');
  }

  const instance = response.Instances[0];
  return {
    instanceId: instance.InstanceId!,
    state: instance.State?.Name || 'unknown',
  };
}

export async function getInstanceStatus(
  instanceId: string,
  region: string
): Promise<InstanceStatus> {
  const client = await createEC2Client(region);

  const response = await client.send(
    new DescribeInstancesCommand({
      InstanceIds: [instanceId],
    })
  );

  if (!response.Reservations || response.Reservations.length === 0) {
    throw new Error(`Instance ${instanceId} not found`);
  }

  const instance = response.Reservations[0].Instances?.[0];
  if (!instance) {
    throw new Error(`Instance ${instanceId} not found`);
  }

  return {
    instanceId: instance.InstanceId!,
    state: (instance.State?.Name || 'unknown') as InstanceStatus['state'],
    stateReason: instance.StateReason?.Message,
    publicIpAddress: instance.PublicIpAddress,
    privateIpAddress: instance.PrivateIpAddress,
    launchTime: instance.LaunchTime,
  };
}

export interface WaitOptions {
  maxWaitTimeSeconds?: number;
  onProgress?: (status: InstanceStatus) => void;
}

export async function waitForInstanceRunning(
  instanceId: string,
  region: string,
  options: WaitOptions = {}
): Promise<InstanceStatus> {
  const maxWaitTime = options.maxWaitTimeSeconds || 300; // 5 minutes default
  const pollInterval = 5000; // 5 seconds
  const startTime = Date.now();

  while (true) {
    let status: InstanceStatus;
    try {
      status = await getInstanceStatus(instanceId, region);
    } catch (error) {
      // Handle EC2 eventual consistency - instance may not be visible immediately after launch
      const isNotFoundError =
        error instanceof Error &&
        (error.message.includes('does not exist') || error.message.includes('not found'));

      const elapsed = (Date.now() - startTime) / 1000;
      if (isNotFoundError && elapsed < 30) {
        // Retry for up to 30 seconds if instance not found yet
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        continue;
      }
      throw error;
    }

    if (options.onProgress) {
      options.onProgress(status);
    }

    if (status.state === 'running') {
      return status;
    }

    if (status.state === 'terminated' || status.state === 'shutting-down') {
      throw new Error(
        `Instance ${instanceId} failed to start: ${status.stateReason || status.state}`
      );
    }

    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed >= maxWaitTime) {
      throw new Error(
        `Timeout waiting for instance ${instanceId} to start after ${maxWaitTime}s (current state: ${status.state})`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

export interface SSHReadyOptions {
  maxWaitTimeSeconds?: number;
  pollIntervalSeconds?: number;
  onProgress?: (attempt: number) => void;
}

function checkTCPPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

export async function waitForSSHReady(host: string, options: SSHReadyOptions = {}): Promise<void> {
  const maxWaitTime = options.maxWaitTimeSeconds ?? 180;
  const pollInterval = options.pollIntervalSeconds ?? 5;
  const startTime = Date.now();
  let attempt = 0;

  while (true) {
    attempt++;
    if (await checkTCPPort(host, 22, 5000)) return;

    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed >= maxWaitTime) {
      throw new Error(`Timeout waiting for SSH on ${host}:22 after ${maxWaitTime}s`);
    }

    options.onProgress?.(attempt);
    await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));
  }
}

export interface BootstrapReadyOptions {
  maxWaitTimeSeconds?: number;
  pollIntervalSeconds?: number;
  onProgress?: (status: string) => void;
}

export function runSSHCommand(
  host: string,
  sshKeyPath: string,
  command: string
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const args = [
      '-i',
      sshKeyPath,
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'BatchMode=yes',
      `ubuntu@${host}`,
      command,
    ];

    const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        output: stdout || stderr,
      });
    });

    proc.on('error', () => {
      resolve({ success: false, output: '' });
    });
  });
}

/**
 * Fetch Tailscale-related log lines from the bootstrap log on a workstation.
 * Returns the log lines or null if SSH fails.
 */
export async function getBootstrapTailscaleLogs(
  host: string,
  sshKeyPath: string
): Promise<string | null> {
  const result = await runSSHCommand(
    host,
    sshKeyPath,
    'grep -i tailscale /opt/clawdult/logs/bootstrap-openclaw.log 2>/dev/null | tail -20'
  );
  if (result.success && result.output.trim()) {
    return result.output.trim();
  }
  return null;
}

export async function waitForBootstrapReady(
  host: string,
  sshKeyPath: string,
  options: BootstrapReadyOptions = {}
): Promise<void> {
  const maxWaitTime = options.maxWaitTimeSeconds ?? 300;
  const pollInterval = options.pollIntervalSeconds ?? 10;
  const startTime = Date.now();

  while (true) {
    const result = await runSSHCommand(
      host,
      sshKeyPath,
      'test -f /opt/clawdult/.ready && echo ready'
    );

    if (result.success && result.output.trim() === 'ready') {
      return;
    }

    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed >= maxWaitTime) {
      throw new Error(`Timeout waiting for bootstrap to complete on ${host} after ${maxWaitTime}s`);
    }

    options.onProgress?.(`Waiting for bootstrap... (${Math.floor(elapsed)}s elapsed)`);
    await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));
  }
}

function parseInstanceToManaged(instance: Instance, region: string): ManagedInstance | null {
  const tags = instance.Tags || [];
  const getTag = (key: string) => tags.find((t) => t.Key === key)?.Value;

  const name = getTag('clawdult:agent');
  if (!name) return null;

  return {
    instanceId: instance.InstanceId!,
    state: (instance.State?.Name || 'unknown') as ManagedInstance['state'],
    publicIp: instance.PublicIpAddress,
    privateIp: instance.PrivateIpAddress,
    launchTime: instance.LaunchTime,
    instanceType: instance.InstanceType || 'unknown',
    region,
    name,
    keyProfileName: getTag('clawdult:keyProfileName'),
    githubAgentUsername: getTag('clawdult:githubAgentUsername'),
  };
}

export interface ListManagedOptions {
  includeTerminated?: boolean;
}

export async function listManagedInstances(
  region: string,
  options: ListManagedOptions = {}
): Promise<ManagedInstance[]> {
  const client = await createEC2Client(region);

  const filters = [{ Name: 'tag:clawdult:managed', Values: ['true'] }];

  if (!options.includeTerminated) {
    filters.push({
      Name: 'instance-state-name',
      Values: ['pending', 'running', 'stopping', 'stopped', 'shutting-down'],
    });
  }

  const response = await client.send(new DescribeInstancesCommand({ Filters: filters }));

  const instances: ManagedInstance[] = [];
  for (const reservation of response.Reservations || []) {
    for (const instance of reservation.Instances || []) {
      const managed = parseInstanceToManaged(instance, region);
      if (managed) {
        instances.push(managed);
      }
    }
  }

  return instances;
}

export async function getManagedInstance(
  name: string,
  region: string
): Promise<ManagedInstance | null> {
  const client = await createEC2Client(region);

  const response = await client.send(
    new DescribeInstancesCommand({
      Filters: [
        { Name: 'tag:clawdult:managed', Values: ['true'] },
        { Name: 'tag:clawdult:agent', Values: [name] },
        {
          Name: 'instance-state-name',
          Values: ['pending', 'running', 'stopping', 'stopped', 'shutting-down'],
        },
      ],
    })
  );

  for (const reservation of response.Reservations || []) {
    for (const instance of reservation.Instances || []) {
      const managed = parseInstanceToManaged(instance, region);
      if (managed) {
        return managed;
      }
    }
  }

  return null;
}

export async function terminateInstance(instanceId: string, region: string): Promise<void> {
  const client = await createEC2Client(region);
  await client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
}

const SECURITY_GROUP_NAME = 'clawdult-ssh';
const SECURITY_GROUP_DESCRIPTION = 'Clawdult workstation SSH access';

const PACKER_SECURITY_GROUP_NAME = 'clawdult-packer-builder';
const PACKER_SECURITY_GROUP_DESCRIPTION = 'Clawdult Packer builder SSH access';

export async function getDefaultVpcId(region: string): Promise<string> {
  const client = await createEC2Client(region);
  const response = await client.send(
    new DescribeVpcsCommand({
      Filters: [{ Name: 'is-default', Values: ['true'] }],
    })
  );

  if (!response.Vpcs || response.Vpcs.length === 0) {
    throw new Error(`No default VPC found in ${region}`);
  }

  return response.Vpcs[0].VpcId!;
}

export async function ensureSSHSecurityGroup(
  region: string,
  allowedCidr?: string
): Promise<string> {
  const client = await createEC2Client(region);
  const vpcId = await getDefaultVpcId(region);

  // Check if security group already exists
  const existing = await client.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: 'group-name', Values: [SECURITY_GROUP_NAME] },
        { Name: 'vpc-id', Values: [vpcId] },
      ],
    })
  );

  if (existing.SecurityGroups && existing.SecurityGroups.length > 0) {
    const groupId = existing.SecurityGroups[0].GroupId!;
    // Ensure SSH rule is present when CIDR is provided (idempotent)
    if (allowedCidr) {
      await addSecurityGroupIngress(region, groupId, allowedCidr, 'SSH access');
    }
    return groupId;
  }

  // Create security group
  const createResult = await client.send(
    new CreateSecurityGroupCommand({
      GroupName: SECURITY_GROUP_NAME,
      Description: SECURITY_GROUP_DESCRIPTION,
      VpcId: vpcId,
      TagSpecifications: [
        {
          ResourceType: 'security-group',
          Tags: [
            { Key: 'Name', Value: SECURITY_GROUP_NAME },
            { Key: 'clawdult:managed', Value: 'true' },
          ],
        },
      ],
    })
  );

  const groupId = createResult.GroupId!;

  // Only add SSH ingress rule if CIDR is provided
  // If no CIDR, Tailscale handles connectivity
  if (allowedCidr) {
    await client.send(
      new AuthorizeSecurityGroupIngressCommand({
        GroupId: groupId,
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 22,
            ToPort: 22,
            IpRanges: [{ CidrIp: allowedCidr, Description: 'SSH access' }],
          },
        ],
      })
    );
  }

  return groupId;
}

export async function getCallerPublicIp(): Promise<string> {
  const endpoints = ['https://checkip.amazonaws.com', 'https://api.ipify.org'];
  for (const url of endpoints) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) continue;
      const ip = (await response.text()).trim();
      if (ip) return ip;
    } catch {
      continue;
    }
  }
  throw new Error('Failed to determine public IP: all endpoints unreachable');
}

export async function addSecurityGroupIngress(
  region: string,
  sgId: string,
  cidr: string,
  description: string
): Promise<void> {
  const client = await createEC2Client(region);
  try {
    await client.send(
      new AuthorizeSecurityGroupIngressCommand({
        GroupId: sgId,
        IpPermissions: [
          {
            IpProtocol: 'tcp',
            FromPort: 22,
            ToPort: 22,
            IpRanges: [{ CidrIp: cidr, Description: description }],
          },
        ],
      })
    );
  } catch (error: unknown) {
    // Rule already exists - that's fine
    if (error instanceof Error && error.name === 'InvalidPermission.Duplicate') {
      return;
    }
    throw error;
  }
}

export async function ensurePackerSecurityGroup(region: string): Promise<string> {
  const client = await createEC2Client(region);
  const vpcId = await getDefaultVpcId(region);

  // Check if security group already exists
  const existing = await client.send(
    new DescribeSecurityGroupsCommand({
      Filters: [
        { Name: 'group-name', Values: [PACKER_SECURITY_GROUP_NAME] },
        { Name: 'vpc-id', Values: [vpcId] },
      ],
    })
  );

  if (existing.SecurityGroups && existing.SecurityGroups.length > 0) {
    const sg = existing.SecurityGroups[0];
    const groupId = sg.GroupId!;

    // Check if tags need to be added
    const tags = sg.Tags || [];
    const hasNameTag = tags.some((t) => t.Key === 'Name' && t.Value === PACKER_SECURITY_GROUP_NAME);
    const hasManagedTag = tags.some((t) => t.Key === 'clawdult:managed' && t.Value === 'true');

    if (!hasNameTag || !hasManagedTag) {
      const tagsToAdd = [];
      if (!hasNameTag) {
        tagsToAdd.push({ Key: 'Name', Value: PACKER_SECURITY_GROUP_NAME });
      }
      if (!hasManagedTag) {
        tagsToAdd.push({ Key: 'clawdult:managed', Value: 'true' });
      }
      await client.send(
        new CreateTagsCommand({
          Resources: [groupId],
          Tags: tagsToAdd,
        })
      );
    }

    return groupId;
  }

  // Get caller's public IP for SSH ingress
  const callerIp = await getCallerPublicIp();

  // Create security group
  const createResult = await client.send(
    new CreateSecurityGroupCommand({
      GroupName: PACKER_SECURITY_GROUP_NAME,
      Description: PACKER_SECURITY_GROUP_DESCRIPTION,
      VpcId: vpcId,
      TagSpecifications: [
        {
          ResourceType: 'security-group',
          Tags: [
            { Key: 'Name', Value: PACKER_SECURITY_GROUP_NAME },
            { Key: 'clawdult:managed', Value: 'true' },
          ],
        },
      ],
    })
  );

  const groupId = createResult.GroupId!;

  // Add SSH ingress rule scoped to caller's IP
  await client.send(
    new AuthorizeSecurityGroupIngressCommand({
      GroupId: groupId,
      IpPermissions: [
        {
          IpProtocol: 'tcp',
          FromPort: 22,
          ToPort: 22,
          IpRanges: [{ CidrIp: `${callerIp}/32`, Description: 'SSH access for Packer' }],
        },
      ],
    })
  );

  return groupId;
}

export async function listKeyPairs(region: string): Promise<string[]> {
  const client = await createEC2Client(region);
  const response = await client.send(new DescribeKeyPairsCommand({}));
  return (response.KeyPairs || []).map((kp) => kp.KeyName!).filter(Boolean);
}

export async function keyPairExists(keyName: string, region: string): Promise<boolean> {
  const client = await createEC2Client(region);
  try {
    const response = await client.send(
      new DescribeKeyPairsCommand({
        KeyNames: [keyName],
      })
    );
    return (response.KeyPairs?.length ?? 0) > 0;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'InvalidKeyPair.NotFound') {
      return false;
    }
    throw error;
  }
}

export interface CreateKeyPairResult {
  keyName: string;
  privateKeyPath: string;
}

export async function stopInstance(instanceId: string, region: string): Promise<void> {
  const client = await createEC2Client(region);
  await client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
}

export async function waitForInstanceStopped(
  instanceId: string,
  region: string,
  options: WaitOptions = {}
): Promise<InstanceStatus> {
  const maxWaitTime = options.maxWaitTimeSeconds || 300;
  const pollInterval = 5000;
  const startTime = Date.now();

  while (true) {
    const status = await getInstanceStatus(instanceId, region);

    if (options.onProgress) {
      options.onProgress(status);
    }

    if (status.state === 'stopped') {
      return status;
    }

    if (status.state === 'terminated') {
      throw new Error(
        `Instance ${instanceId} was terminated: ${status.stateReason || 'unknown reason'}`
      );
    }

    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed >= maxWaitTime) {
      throw new Error(
        `Timeout waiting for instance ${instanceId} to stop after ${maxWaitTime}s (current state: ${status.state})`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

export async function modifyInstanceType(
  instanceId: string,
  region: string,
  instanceType: string
): Promise<void> {
  const client = await createEC2Client(region);
  await client.send(
    new ModifyInstanceAttributeCommand({
      InstanceId: instanceId,
      InstanceType: { Value: instanceType },
    })
  );
}

export async function startInstance(instanceId: string, region: string): Promise<void> {
  const client = await createEC2Client(region);
  await client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
}

export async function createAmiFromInstance(
  instanceId: string,
  region: string,
  name: string,
  description?: string
): Promise<string> {
  const client = await createEC2Client(region);

  const response = await client.send(
    new CreateImageCommand({
      InstanceId: instanceId,
      Name: name,
      Description: description,
      NoReboot: false,
      TagSpecifications: [
        {
          ResourceType: 'image',
          Tags: [
            { Key: 'Name', Value: name },
            { Key: 'clawdult:managed', Value: 'true' },
          ],
        },
        {
          ResourceType: 'snapshot',
          Tags: [
            { Key: 'Name', Value: `${name}-snapshot` },
            { Key: 'clawdult:managed', Value: 'true' },
          ],
        },
      ],
    })
  );

  if (!response.ImageId) {
    throw new Error('CreateImage returned no ImageId');
  }

  return response.ImageId;
}

export async function waitForAmiAvailable(
  imageId: string,
  region: string,
  options: WaitOptions = {}
): Promise<void> {
  const maxWaitTime = options.maxWaitTimeSeconds || 600;
  const pollInterval = 15000;
  const startTime = Date.now();

  while (true) {
    const ami = await describeAmi(imageId, region);
    if (!ami) {
      throw new Error(`AMI ${imageId} not found`);
    }

    if (ami.state === 'available') {
      return;
    }

    if (ami.state === 'failed' || ami.state === 'deregistered') {
      throw new Error(`AMI ${imageId} failed: ${ami.state}`);
    }

    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed >= maxWaitTime) {
      throw new Error(
        `Timeout waiting for AMI ${imageId} to become available after ${maxWaitTime}s (current state: ${ami.state})`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

export interface AmiInfo {
  imageId: string;
  name?: string;
  state: string;
  description?: string;
}

export async function describeAmi(imageId: string, region: string): Promise<AmiInfo | null> {
  const client = await createEC2Client(region);

  try {
    const response = await client.send(new DescribeImagesCommand({ ImageIds: [imageId] }));

    if (!response.Images || response.Images.length === 0) {
      return null;
    }

    const image = response.Images[0];
    return {
      imageId: image.ImageId!,
      name: image.Name,
      state: image.State || 'unknown',
      description: image.Description,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'InvalidAMIID.NotFound') {
      return null;
    }
    throw error;
  }
}

export async function deregisterAmi(imageId: string, region: string): Promise<void> {
  const client = await createEC2Client(region);
  await client.send(new DeregisterImageCommand({ ImageId: imageId }));
}

export async function copyAmiToRegion(
  imageId: string,
  sourceRegion: string,
  destRegion: string,
  name: string
): Promise<string> {
  const client = await createEC2Client(destRegion);

  const response = await client.send(
    new CopyImageCommand({
      SourceImageId: imageId,
      SourceRegion: sourceRegion,
      Name: name,
      Description: `Copy of ${imageId} from ${sourceRegion}`,
    })
  );

  if (!response.ImageId) {
    throw new Error('CopyImage returned no ImageId');
  }

  return response.ImageId;
}

export async function createKeyPair(keyName: string, region: string): Promise<CreateKeyPairResult> {
  const client = await createEC2Client(region);

  const response = await client.send(
    new CreateKeyPairCommand({
      KeyName: keyName,
      KeyType: 'ed25519',
      TagSpecifications: [
        {
          ResourceType: 'key-pair',
          Tags: [
            { Key: 'Name', Value: `clawdult-${keyName}` },
            { Key: 'clawdult:managed', Value: 'true' },
          ],
        },
      ],
    })
  );

  if (!response.KeyMaterial) {
    throw new Error('Failed to create key pair: no key material returned');
  }

  // Save private key to ~/.ssh/
  const sshDir = path.join(os.homedir(), '.ssh');
  await fs.mkdir(sshDir, { recursive: true });

  const privateKeyPath = path.join(sshDir, `${keyName}.pem`);
  await fs.writeFile(privateKeyPath, response.KeyMaterial, { mode: 0o600 });

  return {
    keyName,
    privateKeyPath,
  };
}
