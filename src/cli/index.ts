#!/usr/bin/env node

import { Command } from 'commander';
import { createCommand } from './commands/create/index.js';
import { destroyCommand } from './commands/destroy.js';
import { statusCommand } from './commands/status.js';
import { sshCommand } from './commands/ssh.js';
import { cpCommand } from './commands/cp.js';
import { logsCommand } from './commands/logs.js';
import { listCommand } from './commands/list.js';
import { configCommand } from './commands/config.js';
import { setupAdminCommand } from './commands/setup-admin/index.js';
import { secretsCommand } from './commands/secrets.js';
import { completionCommand } from './commands/completion.js';
import { profilesCommand } from './commands/profiles/index.js';
import { gatewayCommand } from './commands/gateway.js';
import { trainCommand } from './commands/train.js';
import { specsCommand } from './commands/specs.js';
import { resizeCommand } from './commands/resize.js';
import { stopCommand } from './commands/stop.js';
import { startCommand } from './commands/start.js';
import { cloneCommand } from './commands/clone.js';
import { snapshotsCommand } from './commands/snapshots/index.js';
import { permissionsCommand } from './commands/permissions.js';
import { handleCompletion } from './completion/index.js';
import chalk from 'chalk';
import { CLIError } from './utils/errors.js';

// Handle tab completion before parsing commands
if (process.env.COMP_LINE !== undefined) {
  await handleCompletion();
  process.exit(0);
}

const program = new Command();

program
  .name('clawdult')
  .description('AI Agent Workstation Provisioner - Provision dedicated EC2 instances for AI agents')
  .version('0.1.0');

program.addCommand(createCommand);
program.addCommand(destroyCommand);
program.addCommand(statusCommand);
program.addCommand(sshCommand);
program.addCommand(cpCommand);
program.addCommand(logsCommand);
program.addCommand(listCommand);
program.addCommand(configCommand);
program.addCommand(setupAdminCommand);
program.addCommand(secretsCommand);
program.addCommand(profilesCommand);
program.addCommand(gatewayCommand);
program.addCommand(trainCommand);
program.addCommand(specsCommand);
program.addCommand(resizeCommand);
program.addCommand(stopCommand);
program.addCommand(startCommand);
program.addCommand(cloneCommand);
program.addCommand(snapshotsCommand);
program.addCommand(permissionsCommand);
program.addCommand(completionCommand);

program.parseAsync().catch((error: unknown) => {
  if (error instanceof CLIError) {
    console.error(chalk.red(error.message));
    process.exit(error.exitCode);
  }
  // Re-throw unexpected errors
  throw error;
});
