/**
 * Activity inference types + the validated-activities proxy used by
 * `declareWorkflow`. Split out of `workflow.ts` to keep that file focused
 * on `declareWorkflow` and its `WorkflowContext` type. Not part of the
 * worker package's public exports.
 */
import type {
  ActivityDefinition,
  AnyWorkflowDefinition,
  ContractDefinition,
} from "@temporal-contract/contract";
import { ActivityInputValidationError, ActivityOutputValidationError } from "./errors.js";
import type { ClientInferInput, ClientInferOutput } from "./types.js";

/**
 * Activity function signature from workflow execution perspective.
 *
 * Workflows call activities with validated input (z.input parsed) and receive validated output (z.output).
 */
export type WorkflowInferActivity<TActivity extends ActivityDefinition> = (
  args: ClientInferInput<TActivity>,
) => Promise<ClientInferOutput<TActivity>>;

/**
 * All global activities from a contract (workflow execution perspective).
 */
export type WorkflowInferActivities<TContract extends ContractDefinition> =
  TContract["activities"] extends Record<string, ActivityDefinition>
    ? {
        [K in keyof TContract["activities"]]: WorkflowInferActivity<TContract["activities"][K]>;
      }
    : {};

/**
 * Workflow-specific activities (workflow execution perspective).
 */
export type WorkflowInferWorkflowActivities<T extends AnyWorkflowDefinition> =
  T["activities"] extends Record<string, ActivityDefinition>
    ? {
        [K in keyof T["activities"]]: WorkflowInferActivity<T["activities"][K]>;
      }
    : {};

/**
 * All activities available in a workflow context (workflow execution perspective).
 *
 * Combines workflow-specific activities with global contract activities.
 */
export type WorkflowInferWorkflowContextActivities<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
> = WorkflowInferWorkflowActivities<TContract["workflows"][TWorkflowName]> &
  WorkflowInferActivities<TContract>;

/**
 * Wrap the raw activities proxy with input/output validation against the
 * Standard Schema definitions on the contract. The wrapper enforces data
 * integrity at the workflow → activity boundary in addition to the
 * activity-side validation that `declareActivitiesHandler` already runs.
 */
export function createValidatedActivities<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
>(
  rawActivities: Record<string, (...args: unknown[]) => Promise<unknown>>,
  workflowActivitiesDefinition: Record<string, ActivityDefinition> | undefined,
  contractActivitiesDefinition: Record<string, ActivityDefinition> | undefined,
): WorkflowInferWorkflowContextActivities<TContract, TWorkflowName> {
  const validatedActivities = {} as WorkflowInferWorkflowContextActivities<
    TContract,
    TWorkflowName
  >;

  // Merge workflow-specific and global contract activities. defineContract
  // guarantees there are no name collisions across scopes, so spread order
  // is just a stable iteration choice (workflow-local last).
  const allActivitiesDefinition = {
    ...contractActivitiesDefinition,
    ...workflowActivitiesDefinition,
  };

  for (const [activityName, activityDef] of Object.entries(allActivitiesDefinition)) {
    const rawActivity = rawActivities[activityName];

    if (!rawActivity) {
      throw new Error(
        `Activity implementation not found for: "${activityName}". ` +
          `Available activities: ${Object.keys(rawActivities).length > 0 ? Object.keys(rawActivities).join(", ") : "none"}`,
      );
    }

    (validatedActivities as Record<string, unknown>)[activityName] = async (input: unknown) => {
      const inputResult = await activityDef.input["~standard"].validate(input);
      if (inputResult.issues) {
        throw new ActivityInputValidationError(activityName, inputResult.issues);
      }

      const result = await rawActivity(inputResult.value);

      const outputResult = await activityDef.output["~standard"].validate(result);
      if (outputResult.issues) {
        throw new ActivityOutputValidationError(activityName, outputResult.issues);
      }

      return outputResult.value;
    };
  }

  return validatedActivities;
}
