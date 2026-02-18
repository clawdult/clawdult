import { select } from '@inquirer/prompts';
import ora from 'ora';
import { loadGlobalConfig } from '../../services/config.js';
import {
  getManagedInstance,
  listManagedInstances,
  type ManagedInstance,
} from '../../services/ec2.js';
import { CLIError } from './errors.js';

export interface ResolveInstanceOptions {
  name?: string;
  region?: string;
  filterStates?: ManagedInstance['state'][];
  selectMessage?: string;
}

export async function resolveInstance(options: ResolveInstanceOptions): Promise<ManagedInstance> {
  const globalConfig = await loadGlobalConfig();
  const region = options.region || globalConfig.defaultRegion;

  let targetName = options.name;

  if (!targetName) {
    const spinner = ora(`Querying ${region}...`).start();
    let instances = await listManagedInstances(region);
    spinner.stop();

    if (options.filterStates) {
      instances = instances.filter((w) => options.filterStates!.includes(w.state));
    }

    if (instances.length === 0) {
      const stateLabel = options.filterStates ? options.filterStates.join('/') + ' ' : '';
      throw new CLIError(`No ${stateLabel}workstations found in ${region}.`);
    }

    targetName = await select({
      message: options.selectMessage || 'Select workstation:',
      choices: instances.map((w) => ({
        value: w.name,
        name: `${w.name} (${w.instanceId}) - ${w.state}`,
      })),
    });
  }

  const spinner = ora(`Looking up ${targetName}...`).start();
  const instance = await getManagedInstance(targetName, region);
  spinner.stop();

  if (!instance) {
    throw new CLIError(`Workstation '${targetName}' not found in ${region}.`);
  }

  return instance;
}
