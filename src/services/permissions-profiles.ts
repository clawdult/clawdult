import os from 'node:os';
import path from 'node:path';
import { createProfileStore } from './profile-store.js';
import { PermissionsProfileSchema, type PermissionsProfile } from '../schemas/config.js';
import type { IamStatement } from '../schemas/config.js';

const PERMISSIONS_PROFILES_DIR = path.join(os.homedir(), '.clawdult', 'permissions-profiles');

const store = createProfileStore(PERMISSIONS_PROFILES_DIR, PermissionsProfileSchema);

export const listPermissionsProfiles = store.list;
export const getPermissionsProfile = store.get;
export const savePermissionsProfile = store.save;
export const deletePermissionsProfile = store.delete;

export async function createPermissionsProfile(
  name: string,
  statements: IamStatement[],
  description?: string
): Promise<PermissionsProfile> {
  const profile: PermissionsProfile = {
    name,
    createdAt: new Date().toISOString(),
    description,
    statements,
  };

  await savePermissionsProfile(profile);
  return profile;
}

export function getPermissionsDescription(profile: PermissionsProfile): string {
  const count = profile.statements.length;
  const actions = profile.statements.flatMap((s) =>
    Array.isArray(s.Action) ? s.Action : [s.Action]
  );
  const uniqueServices = new Set(actions.map((a) => a.split(':')[0]));
  const serviceList = [...uniqueServices].slice(0, 3).join(', ');
  const suffix = uniqueServices.size > 3 ? ` +${uniqueServices.size - 3} more` : '';
  return `${count} statement${count === 1 ? '' : 's'}, services: ${serviceList}${suffix}`;
}
