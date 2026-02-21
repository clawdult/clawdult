import { z } from 'zod';

export const InstanceTypeSchema = z.enum([
  't3.micro',
  't3.small',
  't3.medium',
  't3.large',
  't3.xlarge',
  'm6i.large',
  'm6i.xlarge',
]);

export type InstanceType = z.infer<typeof InstanceTypeSchema>;

export const RegionSchema = z.enum([
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-central-1',
  'ap-northeast-1',
  'ap-southeast-1',
  'ap-southeast-2',
]);

export type Region = z.infer<typeof RegionSchema>;

export const WorkstationConfigSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/),
  instanceType: InstanceTypeSchema.default('t3.medium'),
  region: RegionSchema.default('us-east-1'),
  volumeSize: z.number().int().min(20).max(500).default(50),
  owner: z.string().optional(),
  tags: z.record(z.string()).optional(),
});

export type WorkstationConfig = z.infer<typeof WorkstationConfigSchema>;

export const GitHubAgentAccountSchema = z.object({
  username: z.string().min(1),
  email: z.string().email(),
  createdAt: z.string().datetime(),
  description: z.string().optional(),
});

export type GitHubAgentAccount = z.infer<typeof GitHubAgentAccountSchema>;

export const GlobalConfigSchema = z.object({
  defaultRegion: RegionSchema.default('us-east-1'),
  defaultInstanceType: InstanceTypeSchema.default('t3.medium'),
  defaultVolumeSize: z.number().int().min(20).max(500).default(50),
  sshKeyPath: z.string().optional(),
  sshKeyName: z.string().optional(), // EC2 key pair name
  // Map of EC2 key pair name -> local private key file path
  sshKeyPaths: z.record(z.string()).default({}),
  awsProfile: z.string().optional(),
  logsDirectory: z.string().default('~/.clawdult/logs'),
  // GitHub agent accounts registry
  githubAgentAccounts: z.array(GitHubAgentAccountSchema).default([]),
  // SSH CIDR for public access (e.g., "1.2.3.4/32" or "10.0.0.0/8")
  // If not set and no Tailscale, user will be prompted during create
  allowedSshCidr: z.string().optional(),
});

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export const ToolsConfigSchema = z.object({
  claudeCode: z.boolean().default(true),
  codex: z.boolean().default(true),
  grok: z.boolean().default(false),
  gemini: z.boolean().default(false),
  playwright: z.boolean().default(true),
  docker: z.boolean().default(true),
});

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

export const WorkstationSnapshotSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-zA-Z0-9-_]+$/),
  createdAt: z.string().datetime(),
  description: z.string().optional(),
  amiId: z.string().regex(/^ami-[a-f0-9]+$/),
  amiRegion: RegionSchema,
  sourceWorkstationName: z.string(),
  sourceInstanceId: z.string(),
  instanceType: InstanceTypeSchema,
  region: RegionSchema,
  volumeSize: z.number().int().min(20).max(500),
  keyProfileName: z.string().optional(),
  connectivityProfileName: z.string().optional(),
  githubAgentUsername: z.string().optional(),
  tags: z.record(z.string()).optional(),
});

export type WorkstationSnapshot = z.infer<typeof WorkstationSnapshotSchema>;
