import chalk from 'chalk';
import type { ManagedInstance } from '../../services/ec2.js';

export function formatState(state: ManagedInstance['state']): string {
  switch (state) {
    case 'running':
      return chalk.green('● running');
    case 'pending':
      return chalk.yellow('○ pending');
    case 'stopping':
      return chalk.yellow('◐ stopping');
    case 'stopped':
      return chalk.gray('○ stopped');
    case 'shutting-down':
      return chalk.yellow('◐ shutting-down');
    case 'terminated':
      return chalk.red('✕ terminated');
    default:
      return chalk.gray(state);
  }
}

export function formatDuration(launchTime?: Date): string {
  if (!launchTime) return '-';

  const now = new Date();
  const diff = now.getTime() - launchTime.getTime();

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  const minutes = Math.floor(diff / (1000 * 60));
  return `${minutes}m`;
}
