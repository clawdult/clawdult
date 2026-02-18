import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tabtabInstaller = require('tabtab/lib/installer') as {
  install: (options: { name: string; completer: string; location: string }) => Promise<void>;
  uninstall: (options: { name: string }) => Promise<void>;
};

const COMPLETION_MARKER_START = '# clawdult completion start';
const COMPLETION_MARKER_END = '# clawdult completion end';

function detectShell(): string {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return 'zsh';
  if (shell.includes('bash')) return 'bash';
  if (shell.includes('fish')) return 'fish';
  return 'bash'; // Default to bash
}

function getCompletionScript(shell: string): string {
  // These scripts source tabtab's completion handling
  switch (shell) {
    case 'zsh':
      return `${COMPLETION_MARKER_START}
# tabtab source for clawdult package
# uninstall by removing these lines
[[ -f ~/.config/tabtab/zsh/__tabtab.zsh ]] && . ~/.config/tabtab/zsh/__tabtab.zsh || true
${COMPLETION_MARKER_END}`;
    case 'bash':
      return `${COMPLETION_MARKER_START}
# tabtab source for clawdult package
# uninstall by removing these lines
[ -f ~/.config/tabtab/bash/__tabtab.bash ] && . ~/.config/tabtab/bash/__tabtab.bash || true
${COMPLETION_MARKER_END}`;
    case 'fish':
      return `${COMPLETION_MARKER_START}
# tabtab source for clawdult package
# uninstall by removing these lines
[ -f ~/.config/tabtab/fish/__tabtab.fish ]; and . ~/.config/tabtab/fish/__tabtab.fish; or true
${COMPLETION_MARKER_END}`;
    default:
      throw new Error(`Unsupported shell: ${shell}`);
  }
}

function getShellConfigPath(shell: string): string {
  const home = os.homedir();
  switch (shell) {
    case 'zsh':
      return path.join(home, '.zshrc');
    case 'bash':
      return path.join(home, '.bashrc');
    case 'fish':
      return path.join(home, '.config', 'fish', 'config.fish');
    default:
      throw new Error(`Unsupported shell: ${shell}`);
  }
}

async function removeCompletionBlock(content: string): Promise<string> {
  const startIdx = content.indexOf(COMPLETION_MARKER_START);
  const endIdx = content.indexOf(COMPLETION_MARKER_END);

  if (startIdx !== -1 && endIdx !== -1) {
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + COMPLETION_MARKER_END.length);
    return before.trimEnd() + after.trimStart();
  }
  return content;
}

async function installCompletions(shell: string): Promise<void> {
  const configPath = getShellConfigPath(shell);
  const completionScript = getCompletionScript(shell);

  // Ensure directory exists for fish
  if (shell === 'fish') {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
  }

  // Read existing config or start with empty
  let existingContent = '';
  try {
    existingContent = await fs.readFile(configPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  // Remove existing completion block if present
  existingContent = await removeCompletionBlock(existingContent);

  // Append new completion block
  const newContent = existingContent.trimEnd() + '\n\n' + completionScript + '\n';
  await fs.writeFile(configPath, newContent, 'utf-8');

  // Also run tabtab install to set up the tabtab scripts themselves
  // (this creates ~/.config/tabtab/{shell}/__tabtab.{ext})
  await tabtabInstaller.install({
    name: 'clawdult',
    completer: 'clawdult',
    location: configPath,
  });
}

async function uninstallCompletions(shell: string): Promise<void> {
  const configPath = getShellConfigPath(shell);

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const newContent = await removeCompletionBlock(content);
    await fs.writeFile(configPath, newContent, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  // Also run tabtab uninstall
  await tabtabInstaller.uninstall({
    name: 'clawdult',
  });
}

export const completionCommand = new Command('completion').description(
  'Manage shell tab completions'
);

completionCommand
  .command('install')
  .description('Install shell completions')
  .action(async () => {
    const shell = detectShell();

    if (!['bash', 'zsh', 'fish'].includes(shell)) {
      console.error(chalk.red(`Unsupported shell: ${shell}`));
      console.error(chalk.dim('Supported shells: bash, zsh, fish'));
      process.exit(1);
    }

    console.log(chalk.bold(`Installing ${shell} completions for clawdult...`));

    try {
      await installCompletions(shell);

      console.log(chalk.green('✓ Shell completions installed successfully'));
      console.log(chalk.dim(`\n  Completions will be active in new shell sessions.`));
      console.log(chalk.dim(`  To activate immediately, run:`));

      if (shell === 'zsh') {
        console.log(chalk.white(`    source ~/.zshrc`));
      } else if (shell === 'bash') {
        console.log(chalk.white(`    source ~/.bashrc`));
      } else if (shell === 'fish') {
        console.log(chalk.white(`    source ~/.config/fish/config.fish`));
      }
    } catch (error) {
      console.error(
        chalk.red('Failed to install completions:'),
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
  });

completionCommand
  .command('uninstall')
  .description('Uninstall shell completions')
  .action(async () => {
    const shell = detectShell();
    console.log(chalk.bold('Uninstalling shell completions...'));

    try {
      await uninstallCompletions(shell);

      console.log(chalk.green('✓ Shell completions uninstalled'));
    } catch (error) {
      console.error(
        chalk.red('Failed to uninstall completions:'),
        error instanceof Error ? error.message : String(error)
      );
      process.exit(1);
    }
  });
