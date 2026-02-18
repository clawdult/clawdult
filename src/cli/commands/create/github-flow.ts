import { input, confirm, password } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { execFile } from 'node:child_process';
import type { GitHubAgentAccount } from '../../../schemas/config.js';
import {
  addAgentAccount,
  storeAgentToken,
  validateToken,
  getNoreplyEmail,
} from '../../../services/github-agent.js';

export async function createNewGitHubAgent(): Promise<GitHubAgentAccount | null> {
  console.log(chalk.cyan('\nTo create a GitHub account for your agent:\n'));
  console.log('  1. Go to github.com/join');
  console.log('  2. Create account with a unique username (e.g., yourname-agent-1)');
  console.log('  3. Verify the email address');
  console.log('  4. Go to github.com/settings/tokens/new (classic token)');
  console.log('  5. Create a Personal Access Token with these scopes:');
  console.log('     • repo          - Create private repos, read/write code, manage PRs');
  console.log('     • workflow      - Push changes to GitHub Actions workflow files\n');

  const openBrowser = await confirm({
    message: 'Open github.com/join in your browser?',
    default: true,
  });

  if (openBrowser) {
    // Open in incognito so user doesn't accidentally use their personal account
    execFile('open', ['-na', 'Google Chrome', '--args', '--incognito', 'https://github.com/join']);
  }

  const ready = await confirm({
    message: 'Press Enter when you have created the account and token...',
    default: true,
  });

  if (!ready) {
    console.log(chalk.dim('Skipping GitHub agent account\n'));
    return null;
  }

  const username = await input({
    message: 'GitHub username for the agent:',
    validate: (v) => {
      if (!v.trim()) return 'Username is required';
      if (!/^[a-zA-Z0-9-]+$/.test(v)) return 'Invalid GitHub username format';
      return true;
    },
  });

  const token = await promptForToken(username);
  if (!token) {
    return null;
  }

  const description = await input({
    message: 'Description for this account (optional):',
  });

  const email = getNoreplyEmail(username);
  const account: GitHubAgentAccount = {
    username,
    email,
    createdAt: new Date().toISOString(),
    description: description || undefined,
  };

  await addAgentAccount(account);
  await storeAgentToken(username, token);

  console.log(chalk.green('✓') + ` GitHub agent account saved: ${username}\n`);
  return account;
}

export async function promptForToken(username: string): Promise<string | null> {
  while (true) {
    const token = await password({
      message: `Personal Access Token for ${username}:`,
      mask: '*',
    });

    if (!token.trim()) {
      const retry = await confirm({
        message: 'No token provided. Try again?',
        default: true,
      });
      if (!retry) return null;
      continue;
    }

    const spinner = ora('Validating token...').start();
    try {
      const user = await validateToken(token);
      if (user.login.toLowerCase() !== username.toLowerCase()) {
        spinner.fail(`Token belongs to ${user.login}, not ${username}`);
        const retry = await confirm({
          message: 'Try again with a different token?',
          default: true,
        });
        if (!retry) return null;
        continue;
      }
      spinner.succeed('Token validated');
      await storeAgentToken(username, token);
      return token;
    } catch (error) {
      spinner.fail(error instanceof Error ? error.message : 'Token validation failed');
      const retry = await confirm({
        message: 'Try again?',
        default: true,
      });
      if (!retry) return null;
    }
  }
}
