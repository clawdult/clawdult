import { getTailscaleIP } from '../../services/ssm.js';
import type { ManagedInstance } from '../../services/ec2.js';
import { CLIError } from './errors.js';

export interface SSHConnection {
  ip: string;
  method: 'tailscale' | 'public';
}

export async function resolveSSHConnection(options: {
  instance: ManagedInstance;
  region: string;
  forceTailscale?: boolean;
}): Promise<SSHConnection> {
  const { instance, region, forceTailscale } = options;
  const tailscaleIp = await getTailscaleIP(instance.name, region);

  if (forceTailscale) {
    if (!tailscaleIp) {
      throw new CLIError(
        `No Tailscale IP found for '${instance.name}'. The workstation may not have Tailscale configured or is still initializing.`
      );
    }
    return { ip: tailscaleIp, method: 'tailscale' };
  }

  if (tailscaleIp) {
    return { ip: tailscaleIp, method: 'tailscale' };
  }

  if (instance.publicIp) {
    return { ip: instance.publicIp, method: 'public' };
  }

  throw new CLIError(
    `Workstation '${instance.name}' has no reachable IP address. No Tailscale IP or public IP available.`
  );
}
