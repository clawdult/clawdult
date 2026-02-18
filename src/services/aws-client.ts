import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { loadGlobalConfig } from './config.js';
import { getDefaultProfileName } from './aws-bootstrap/index.js';

export async function getAWSClientConfig(
  region: string
): Promise<{ region: string; credentials: ReturnType<typeof fromNodeProviderChain> }> {
  const globalConfig = await loadGlobalConfig();
  const profileName = globalConfig.awsProfile ?? getDefaultProfileName();
  return {
    region,
    credentials: fromNodeProviderChain({ profile: profileName }),
  };
}
