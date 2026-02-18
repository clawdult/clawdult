import {
  BudgetsClient,
  CreateBudgetCommand,
  DescribeBudgetCommand,
  UpdateBudgetCommand,
  DescribeNotificationsForBudgetCommand,
  DescribeSubscribersForNotificationCommand,
  type Budget,
  type Subscriber,
} from '@aws-sdk/client-budgets';
import type { BudgetProfile } from '../budget-profiles.js';
import { getAccountId, getProfileConfig } from './credentials.js';

// Budget constants
const JOINT_BUDGET_NAME = 'clawdult-all-workstations';

export interface JointBudgetOptions {
  monthlyLimit: number;
  notificationEmail: string;
  alertThresholds?: number[];
}

export interface JointBudgetInfo {
  exists: boolean;
  name?: string;
  monthlyLimit?: number;
  currentSpend?: number;
  notificationEmail?: string;
}

/**
 * Check if the joint budget for all clawdult workstations exists
 */
export async function checkJointBudgetExists(profile?: string): Promise<JointBudgetInfo> {
  try {
    const accountId = await getAccountId(profile);
    if (!accountId) {
      return { exists: false };
    }

    let clientConfig = {};
    if (profile) {
      const config = await getProfileConfig(profile);
      if (config) {
        clientConfig = {
          credentials: config.credentials,
          region: config.region,
        };
      }
    }
    const client = new BudgetsClient(clientConfig);

    const response = await client.send(
      new DescribeBudgetCommand({
        AccountId: accountId,
        BudgetName: JOINT_BUDGET_NAME,
      })
    );

    if (response.Budget) {
      const budget = response.Budget;

      // Fetch notification email from AWS
      let notificationEmail: string | undefined;
      try {
        const notificationsResponse = await client.send(
          new DescribeNotificationsForBudgetCommand({
            AccountId: accountId,
            BudgetName: JOINT_BUDGET_NAME,
          })
        );

        // Get the first notification and fetch its subscribers
        const notification = notificationsResponse.Notifications?.[0];
        if (notification) {
          const subscribersResponse = await client.send(
            new DescribeSubscribersForNotificationCommand({
              AccountId: accountId,
              BudgetName: JOINT_BUDGET_NAME,
              Notification: notification,
            })
          );

          // Find the first email subscriber
          const emailSubscriber = subscribersResponse.Subscribers?.find(
            (s) => s.SubscriptionType === 'EMAIL'
          );
          if (emailSubscriber?.Address) {
            notificationEmail = emailSubscriber.Address;
          }
        }
      } catch {
        // Ignore errors fetching notifications - budget still exists
      }

      return {
        exists: true,
        name: budget.BudgetName,
        monthlyLimit: budget.BudgetLimit?.Amount
          ? parseFloat(budget.BudgetLimit.Amount)
          : undefined,
        currentSpend: budget.CalculatedSpend?.ActualSpend?.Amount
          ? parseFloat(budget.CalculatedSpend.ActualSpend.Amount)
          : 0,
        notificationEmail,
      };
    }

    return { exists: false };
  } catch (error: unknown) {
    // Budget not found is expected when it doesn't exist
    if (error instanceof Error && error.name === 'NotFoundException') {
      return { exists: false };
    }
    // Re-throw other errors
    throw error;
  }
}

/**
 * Create or update the joint spending limit budget for all clawdult workstations
 */
export async function createJointBudget(
  options: JointBudgetOptions,
  profile?: string
): Promise<{ success: boolean; error?: string; isUpdate?: boolean }> {
  try {
    const accountId = await getAccountId(profile);
    if (!accountId) {
      return { success: false, error: 'Could not determine AWS account ID' };
    }

    let clientConfig = {};
    if (profile) {
      const config = await getProfileConfig(profile);
      if (config) {
        clientConfig = {
          credentials: config.credentials,
          region: config.region,
        };
      }
    }
    const client = new BudgetsClient(clientConfig);

    const thresholds = options.alertThresholds || [50, 80, 100];

    // Build subscribers list
    const subscribers: Subscriber[] = [
      {
        SubscriptionType: 'EMAIL',
        Address: options.notificationEmail,
      },
    ];

    // Build budget object
    const budget: Budget = {
      BudgetName: JOINT_BUDGET_NAME,
      BudgetType: 'COST',
      BudgetLimit: {
        Amount: options.monthlyLimit.toString(),
        Unit: 'USD',
      },
      TimeUnit: 'MONTHLY',
      // Filter by clawdult:managed tag to capture ALL clawdult workstations
      CostFilters: {
        TagKeyValue: ['user:clawdult:managed$true'],
      },
    };

    // Check if budget already exists
    const existingBudget = await checkJointBudgetExists(profile);

    if (existingBudget.exists) {
      // Update existing budget
      await client.send(
        new UpdateBudgetCommand({
          AccountId: accountId,
          NewBudget: budget,
        })
      );
      return { success: true, isUpdate: true };
    }

    // Create new budget with notifications
    await client.send(
      new CreateBudgetCommand({
        AccountId: accountId,
        Budget: budget,
        NotificationsWithSubscribers: thresholds.map((threshold) => ({
          Notification: {
            NotificationType: 'ACTUAL',
            ComparisonOperator: 'GREATER_THAN',
            Threshold: threshold,
            ThresholdType: 'PERCENTAGE',
          },
          Subscribers: subscribers,
        })),
      })
    );

    return { success: true, isUpdate: false };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get the budget name constant
 */
export function getJointBudgetName(): string {
  return JOINT_BUDGET_NAME;
}

/**
 * Get AWS console URL for viewing budgets
 */
export function getBudgetConsoleUrl(): string {
  return 'https://console.aws.amazon.com/billing/home#/budgets';
}

/**
 * Apply a budget profile to the joint AWS budget
 */
export async function applyBudgetProfile(
  budgetProfile: BudgetProfile,
  awsProfile?: string
): Promise<{ success: boolean; error?: string; isUpdate?: boolean }> {
  return createJointBudget(
    {
      monthlyLimit: budgetProfile.monthlyLimit,
      notificationEmail: budgetProfile.notificationEmail,
      alertThresholds: budgetProfile.alertThresholds,
    },
    awsProfile
  );
}
