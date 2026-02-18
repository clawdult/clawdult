import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createProfileStore } from './profile-store.js';

const BUDGET_PROFILES_DIR = path.join(os.homedir(), '.clawdult', 'budget-profiles');

export const BudgetProfileSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-zA-Z0-9-_]+$/, 'Name must be alphanumeric with hyphens/underscores'),
  createdAt: z.string().datetime(),
  description: z.string().optional(),
  monthlyLimit: z.number().positive(),
  notificationEmail: z.string().email(),
  alertThresholds: z.array(z.number().min(0).max(100)).default([50, 80, 100]),
});

export type BudgetProfile = z.infer<typeof BudgetProfileSchema>;

const store = createProfileStore(BUDGET_PROFILES_DIR, BudgetProfileSchema);

export const listBudgetProfiles = store.list;
export const getBudgetProfile = store.get;
export const saveBudgetProfile = store.save;
export const deleteBudgetProfile = store.delete;

export async function createBudgetProfile(
  name: string,
  monthlyLimit: number,
  notificationEmail: string,
  alertThresholds?: number[],
  description?: string
): Promise<BudgetProfile> {
  const profile: BudgetProfile = {
    name,
    createdAt: new Date().toISOString(),
    description,
    monthlyLimit,
    notificationEmail,
    alertThresholds: alertThresholds ?? [50, 80, 100],
  };

  await saveBudgetProfile(profile);
  return profile;
}

export function getBudgetDescription(profile: BudgetProfile): string {
  return `$${profile.monthlyLimit}/mo, alerts: ${profile.notificationEmail}`;
}
