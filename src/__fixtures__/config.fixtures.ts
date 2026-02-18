import type { GlobalConfig, GitHubAgentAccount } from '../schemas/config.js';
import type { GitHubUser } from '../services/github-agent.js';

export const sampleGitHubUser: GitHubUser = {
  login: 'test-agent',
  id: 12345,
  name: 'Test Agent',
};

export const sampleGitHubAgentAccount: GitHubAgentAccount = {
  username: 'test-agent',
  email: 'test-agent@users.noreply.github.com',
  createdAt: '2024-01-15T10:30:00Z',
  description: 'Test AI coding assistant',
};

export const sampleGitHubAgentAccount2: GitHubAgentAccount = {
  username: 'another-agent',
  email: 'another-agent@users.noreply.github.com',
  createdAt: '2024-02-20T14:00:00Z',
};

export const minimalGlobalConfig: GlobalConfig = {
  defaultRegion: 'us-east-1',
  defaultInstanceType: 't3.medium',
  defaultVolumeSize: 50,
  logsDirectory: '~/.clawdult/logs',
  sshKeyPaths: {},
  githubAgentAccounts: [],
};

export const globalConfigWithAgents: GlobalConfig = {
  ...minimalGlobalConfig,
  githubAgentAccounts: [sampleGitHubAgentAccount, sampleGitHubAgentAccount2],
};

export const customGlobalConfig: GlobalConfig = {
  defaultRegion: 'us-west-2',
  defaultInstanceType: 't3.large',
  defaultVolumeSize: 100,
  logsDirectory: '~/.clawdult/logs',
  sshKeyPath: '~/.ssh/clawdult_key',
  sshKeyName: 'clawdult-key',
  sshKeyPaths: { 'clawdult-key': '~/.ssh/clawdult_key' },
  awsProfile: 'clawdult-dev',
  githubAgentAccounts: [sampleGitHubAgentAccount],
};
