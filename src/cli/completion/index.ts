import tabtab from 'tabtab';
import { getCommandCompletions, INSTANCE_COMMANDS } from './commands.js';
import { getInstanceCompletions } from './instances.js';

export async function handleCompletion(): Promise<void> {
  const env = tabtab.parseEnv(process.env);

  if (!env.complete) {
    return;
  }

  const words = env.line.split(/\s+/).filter(Boolean);
  const lastWord = env.lastPartial || '';
  const endsWithSpace = env.line.endsWith(' ');

  // Determine completion position
  // words[0] = "clawdult", words[1] = command, words[2+] = arguments
  const wordCount = words.length;

  // Position 1: completing command name
  // Case 1: "clawdult <TAB>" -> show all commands
  // Case 2: "clawdult des<TAB>" -> filter commands starting with "des"
  if (wordCount === 1 || (wordCount === 2 && !endsWithSpace)) {
    const partial = wordCount === 2 ? lastWord : '';
    const commands = getCommandCompletions(partial);
    return tabtab.log(commands.map((c) => ({ name: c.name, description: c.description })));
  }

  // Position 2+: command is complete, completing arguments
  const command = words[1];

  // If command takes instance name as first argument
  if (INSTANCE_COMMANDS.includes(command)) {
    // "clawdult destroy <TAB>" -> wordCount=2, endsWithSpace=true
    // "clawdult destroy my<TAB>" -> wordCount=3, endsWithSpace=false
    if (wordCount === 2 || (wordCount === 3 && !endsWithSpace)) {
      const partial = wordCount === 3 ? lastWord : '';
      const instances = await getInstanceCompletions(partial);
      return tabtab.log(instances);
    }
  }

  // No completions for other positions
  return tabtab.log([]);
}
