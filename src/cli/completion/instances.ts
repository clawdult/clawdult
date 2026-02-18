import { getCachedInstances, setCachedInstances } from './cache.js';
import { listManagedInstances } from '../../services/ec2.js';
import { RegionSchema } from '../../schemas/config.js';

async function fetchInstanceNames(): Promise<string[]> {
  try {
    const regions = RegionSchema.options;

    // Query all regions in parallel
    const results = await Promise.allSettled(regions.map((region) => listManagedInstances(region)));

    const names: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        names.push(...result.value.map((i) => i.name));
      }
    }

    return [...new Set(names)]; // Deduplicate
  } catch (error) {
    console.error(`clawdult: failed to fetch instances for completion: ${error}`);
    return [];
  }
}

export async function getInstanceCompletions(partial: string): Promise<string[]> {
  // Try cache first
  let instances = await getCachedInstances();

  if (!instances) {
    // Fetch from AWS and cache
    instances = await fetchInstanceNames();
    await setCachedInstances(instances);
  }

  return instances.filter((name) => name.startsWith(partial));
}
