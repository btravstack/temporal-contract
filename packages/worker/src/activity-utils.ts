// Helper utilities for working with activities
import { ActivityDefinition, ContractDefinition } from "@temporal-contract/contract";

/**
 * Extract activity definitions for a specific workflow from a contract
 *
 * This includes both:
 * - Workflow-specific activities defined under workflow.activities
 * - Global activities defined under contract.activities
 *
 * @param contract - The contract definition
 * @param workflowName - The name of the workflow
 * @returns Activity definitions for the workflow (workflow-specific + global activities merged)
 *
 * @example
 * ```ts
 * const orderWorkflowActivities = getWorkflowActivities(myContract, 'processOrder');
 * // Returns: { processPayment: ActivityDef, reserveInventory: ActivityDef, sendEmail: ActivityDef }
 * // where sendEmail is a global activity
 * ```
 */
export function getWorkflowActivities<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"],
>(contract: TContract, workflowName: TWorkflowName): Record<string, ActivityDefinition> {
  const workflowDef = contract.workflows[workflowName as string];
  const workflowActivities =
    (workflowDef as { activities?: Record<string, ActivityDefinition> })?.activities || {};
  const globalActivities = contract.activities || {};

  // Merge global and workflow-specific activities. defineContract guarantees
  // there are no name collisions across the global and workflow scopes, so the
  // spread order is only a stable iteration choice (workflow-local last).
  return {
    ...globalActivities,
    ...workflowActivities,
  };
}

/**
 * Extract all activity names for a specific workflow from a contract
 *
 * @param contract - The contract definition
 * @param workflowName - The name of the workflow
 * @returns Array of activity names (strings) available for the workflow
 *
 * @example
 * ```ts
 * const activityNames = getWorkflowActivityNames(myContract, 'processOrder');
 * // Returns: ['processPayment', 'reserveInventory', 'sendEmail']
 * ```
 */
export function getWorkflowActivityNames<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"],
>(contract: TContract, workflowName: TWorkflowName): string[] {
  const activities = getWorkflowActivities(contract, workflowName);
  return Object.keys(activities);
}

/**
 * Check if an activity belongs to a specific workflow
 *
 * @param contract - The contract definition
 * @param workflowName - The name of the workflow
 * @param activityName - The name of the activity to check
 * @returns True if the activity is available for the workflow, false otherwise
 *
 * @example
 * ```ts
 * if (isWorkflowActivity(myContract, 'processOrder', 'processPayment')) {
 *   // Activity is available for this workflow
 * }
 * ```
 */
export function isWorkflowActivity<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"],
>(contract: TContract, workflowName: TWorkflowName, activityName: string): boolean {
  const activities = getWorkflowActivities(contract, workflowName);
  return activityName in activities;
}

/**
 * Get all workflow names from a contract
 *
 * @param contract - The contract definition
 * @returns Array of workflow names defined in the contract
 *
 * @example
 * ```ts
 * const workflows = getWorkflowNames(myContract);
 * // Returns: ['processOrder', 'processRefund']
 * ```
 */
export function getWorkflowNames<TContract extends ContractDefinition>(
  contract: TContract,
): Array<keyof TContract["workflows"]> {
  return Object.keys(contract.workflows) as Array<keyof TContract["workflows"]>;
}
