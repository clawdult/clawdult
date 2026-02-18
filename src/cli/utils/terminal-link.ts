import { link } from 'ansi-escapes';
import chalk from 'chalk';

export function clickableUrl(url: string): string {
  return chalk.cyan(link(url, url));
}
