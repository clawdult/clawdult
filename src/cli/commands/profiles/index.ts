import { Command } from 'commander';
import chalk from 'chalk';
import { listKeyProfiles, getConfiguredKeysDescription } from '../../../services/key-profiles.js';
import { listBudgetProfiles, getBudgetDescription } from '../../../services/budget-profiles.js';
import {
  listConnectivityProfiles,
  getConfiguredDescription as getConnectivityDescription,
} from '../../../services/connectivity-profiles.js';
import { keysCommand } from './keys.js';
import { budgetCommand } from './budget.js';
import { connectivityCommand } from './connectivity.js';
import { typesCommand } from './types.js';

export const profilesCommand = new Command('profiles')
  .description('Manage configuration profiles (keys, budget, connectivity)')
  .addCommand(keysCommand)
  .addCommand(budgetCommand)
  .addCommand(connectivityCommand)
  .addCommand(typesCommand)
  .action(async () => {
    console.log(chalk.bold('\nProfile Overview\n'));

    // Key profiles
    const keyProfiles = await listKeyProfiles();
    console.log(chalk.bold.cyan('API Key Profiles') + chalk.dim(` (${keyProfiles.length})`));
    if (keyProfiles.length === 0) {
      console.log(chalk.dim('  No key profiles configured.'));
    } else {
      for (const profile of keyProfiles) {
        const keys = getConfiguredKeysDescription(profile);
        console.log(`  ${chalk.cyan(profile.name)} ${chalk.dim(`(${keys})`)}`);
      }
    }
    console.log();

    // Budget profiles
    const budgetProfiles = await listBudgetProfiles();
    console.log(chalk.bold.cyan('Budget Profiles') + chalk.dim(` (${budgetProfiles.length})`));
    if (budgetProfiles.length === 0) {
      console.log(chalk.dim('  No budget profiles configured.'));
    } else {
      for (const profile of budgetProfiles) {
        const desc = getBudgetDescription(profile);
        console.log(`  ${chalk.cyan(profile.name)} ${chalk.dim(`(${desc})`)}`);
      }
    }
    console.log();

    // Connectivity profiles
    const connectivityProfiles = await listConnectivityProfiles();
    console.log(
      chalk.bold.cyan('Connectivity Profiles') + chalk.dim(` (${connectivityProfiles.length})`)
    );
    if (connectivityProfiles.length === 0) {
      console.log(chalk.dim('  No connectivity profiles configured.'));
    } else {
      for (const profile of connectivityProfiles) {
        const desc = getConnectivityDescription(profile);
        console.log(`  ${chalk.cyan(profile.name)} ${chalk.dim(`(${desc})`)}`);
      }
    }
    console.log();

    // Usage hints
    console.log(chalk.dim('Commands:'));
    console.log(chalk.dim('  clawdult profiles keys [list|create|edit|delete]'));
    console.log(chalk.dim('  clawdult profiles budget [list|create|edit|delete|apply|status]'));
    console.log(chalk.dim('  clawdult profiles connectivity [list|create|edit|delete]'));
    console.log(chalk.dim('  clawdult profiles types [list|show|create|delete]'));
    console.log();
  });
