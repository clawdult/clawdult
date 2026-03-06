// Static command completions for the Clawdult CLI

export const COMMANDS = [
  { name: 'create', description: 'Create a new EC2 workstation' },
  { name: 'destroy', description: 'Terminate an EC2 workstation' },
  { name: 'status', description: 'Show workstation status' },
  { name: 'ssh', description: 'SSH into a workstation' },
  { name: 'cp', description: 'Copy files to/from a workstation' },
  { name: 'logs', description: 'Stream workstation logs' },
  { name: 'list', description: 'List all workstations' },
  { name: 'gateway', description: 'Get gateway connection info' },
  { name: 'resize', description: 'Change instance type of a workstation' },
  { name: 'clone', description: 'Create a copy of a workstation' },
  { name: 'snapshots', description: 'Save and restore workstation snapshots' },
  { name: 'permissions', description: 'Manage custom IAM permissions on workstations' },
  { name: 'config', description: 'Manage configuration' },
  { name: 'setup-admin', description: 'Set up admin prerequisites' },
  { name: 'keys', description: 'Manage SSH keys' },
  { name: 'completion', description: 'Manage shell completions' },
];

// Commands that take an instance name as their first argument
export const INSTANCE_COMMANDS = [
  'destroy',
  'ssh',
  'logs',
  'status',
  'gateway',
  'cp',
  'resize',
  'clone',
];

export function getCommandCompletions(
  partial: string
): Array<{ name: string; description: string }> {
  return COMMANDS.filter((cmd) => cmd.name.startsWith(partial));
}
