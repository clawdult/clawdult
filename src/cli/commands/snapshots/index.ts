import { Command } from 'commander';
import { saveCommand } from './save.js';
import { restoreCommand } from './restore.js';
import { listCommand } from './list.js';
import { deleteCommand } from './delete.js';

export const snapshotsCommand = new Command('snapshots')
  .description('Save and restore workstation snapshots')
  .addCommand(saveCommand)
  .addCommand(restoreCommand)
  .addCommand(listCommand)
  .addCommand(deleteCommand);
