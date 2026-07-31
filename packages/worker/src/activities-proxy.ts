import type {
  ActivityDefinition,
  AnyWorkflowDefinition,
  ContractDefinition,
  ErrorDefinition,
} from "@temporal-contract/contract";
import { summarizeIssues } from "@temporal-contract/contract";
import { type ContractErrorUnion } from "@temporal-contract/contract/errors";
import { _internal_rehydrateContractError } from "@temporal-contract/contract/internal";
import { ActivityFailure, ApplicationFailure } from "@temporalio/common";
/**
 * Activity inference types + the validated-activities proxy used by
 * `declareWorkflow`. Split out of `workflow.ts` to keep that file focused
 * on `declareWorkflow` and its `WorkflowContext` type. Not part of the
 * worker package's public exports.
 */
import { isCancellation } from "@temporalio/workflow";
import { Ok, Err, type AsyncResult } from "unthrown";

import {
  ActivityCancelledError,
  ActivityError,
  ActivityInputValidationError,
  ActivityOutputValidationError,
} from "./errors.js";
import { makeAsyncResult } from "./internal.js";
import type { ClientInferInput, ClientInferOutput } from "./types.js";

/**
 * Activity function signature from workflow execution perspective.
 *
 * Workflows call activities with the input schema's *input* type and receive
 * the output schema's *output* (parsed) type: the workflow side validates
 * the input but transmits the original value (the activity worker parses it
 * on receive), and parses the activity's result on receive.
 *
 * The shape depends on whether the activity declares contract errors:
 *
 * - **No `errors` map** — plain `Promise<Output>`, matching Temporal's native
 *   behavior: a failure (retries exhausted, timeout, cancellation) throws and
 *   propagates unless caught / scoped.
 * - **With an `errors` map** — `AsyncResult<Output, declared union |
 *   ActivityError | ActivityCancelledError>`. Declared failures are
 *   rehydrated from the `ApplicationFailure` wire shape into typed
 *   {@link ContractErrorUnion} members (data re-validated against the
 *   declared schema); any other failure surfaces as
 *   {@link ActivityError} (with Temporal's `ActivityFailure` wrapper
 *   unwrapped to its actionable cause) or {@link ActivityCancelledError}
 *   (mirroring the child-workflow API).
 */
export type WorkflowInferActivity<TActivity extends ActivityDefinition> = TActivity extends {
  errors: infer TErrors extends Record<string, ErrorDefinition>;
}
  ? (
      args: ClientInferInput<TActivity>,
    ) => AsyncResult<
      ClientInferOutput<TActivity>,
      ContractErrorUnion<TErrors> | ActivityError | ActivityCancelledError
    >
  : (args: ClientInferInput<TActivity>) => Promise<ClientInferOutput<TActivity>>;

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
 * Standard Schema definitions on the contract. Per the wire-format contract
 * (validate on send, parse on receive), the wrapper:
 *
 * - VALIDATES the input before dispatch — failing early with a typed error —
 *   but transmits the caller's ORIGINAL value; `declareActivitiesHandler`
 *   (activity worker side) parses it exactly once on receive.
 * - PARSES the activity's result on receive — the activity side validated
 *   its return and transmitted the original value — so a transforming
 *   output schema is applied exactly once, here.
 *
 * Activities that declare contract errors additionally get failure
 * classification: their wrapper returns an `AsyncResult` whose error channel
 * carries the rehydrated typed errors (see {@link WorkflowInferActivity}).
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
      // oxlint-disable-next-line unthrown/no-throw -- declaration-time fail-fast config error: a missing implementation is a wiring bug surfaced at proxy construction
      throw new Error(
        `Activity implementation not found for: "${activityName}". ` +
          `Available activities: ${Object.keys(rawActivities).length > 0 ? Object.keys(rawActivities).join(", ") : "none"}`,
      );
    }

    (validatedActivities as Record<string, unknown>)[activityName] = activityDef.errors
      ? makeResultShapedActivity(activityName, activityDef, rawActivity)
      : makeThrowingActivity(activityName, activityDef, rawActivity);
  }

  return validatedActivities;
}

/**
 * Validation-only wrapper for activities without declared errors — the
 * historical shape: validate input (send the original), invoke, parse
 * output, let failures throw through to Temporal's native handling.
 */
function makeThrowingActivity(
  activityName: string,
  activityDef: ActivityDefinition,
  rawActivity: (...args: unknown[]) => Promise<unknown>,
) {
  return async (input: unknown) => {
    const inputResult = await activityDef.input["~standard"].validate(input);
    if (inputResult.issues) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new ActivityInputValidationError(activityName, inputResult.issues);
    }

    // Send the ORIGINAL input — the activity worker parses on receive.
    const result = await rawActivity(input);

    const outputResult = await activityDef.output["~standard"].validate(result);
    if (outputResult.issues) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new ActivityOutputValidationError(activityName, outputResult.issues);
    }

    return outputResult.value;
  };
}

/**
 * Result-shaped wrapper for activities that declare contract errors.
 * Classification mirrors the child-workflow API (`classifyChildWorkflowError`):
 *
 * - cancellation → `Err(ActivityCancelledError)` (checked first, so a
 *   cancelled activity doesn't surface as a generic failure);
 * - `ApplicationFailure` whose `type` matches a declared error name and
 *   whose `details[0]` validates against the declared `data` schema →
 *   `Err(ContractError)` — the typed rehydration path;
 * - everything else (undeclared type, payload mismatch, timeout, validation
 *   failure at this boundary) → `Err(ActivityError)` with the *unwrapped*
 *   actionable cause;
 * - a throw out of this wrapper itself is an unmodeled bug and rides
 *   unthrown's `defect` channel via `makeAsyncResult`.
 */
function makeResultShapedActivity(
  activityName: string,
  activityDef: ActivityDefinition,
  rawActivity: (...args: unknown[]) => Promise<unknown>,
) {
  return (input: unknown) =>
    makeAsyncResult(async () => {
      const inputResult = await activityDef.input["~standard"].validate(input);
      if (inputResult.issues) {
        return Err(
          new ActivityError(
            activityName,
            `Activity "${activityName}" input validation failed: ${summarizeIssues(inputResult.issues)}`,
            new ActivityInputValidationError(activityName, inputResult.issues),
          ),
        );
      }

      let rawOutput: unknown;
      try {
        // Send the ORIGINAL input — the activity worker parses on receive.
        rawOutput = await rawActivity(input);
      } catch (error) {
        return Err(await classifyActivityError(activityName, activityDef, error));
      }

      const outputResult = await activityDef.output["~standard"].validate(rawOutput);
      if (outputResult.issues) {
        return Err(
          new ActivityError(
            activityName,
            `Activity "${activityName}" output validation failed: ${summarizeIssues(outputResult.issues)}`,
            new ActivityOutputValidationError(activityName, outputResult.issues),
          ),
        );
      }

      return Ok(outputResult.value);
    });
}

/**
 * Map a failure thrown by a workflow-side activity call into the typed error
 * union of an errors-declaring activity.
 */
async function classifyActivityError(
  activityName: string,
  activityDef: ActivityDefinition,
  error: unknown,
): Promise<
  ActivityCancelledError | ActivityError | ContractErrorUnion<Record<string, ErrorDefinition>>
> {
  // Cancellation takes priority: a cancelled activity surfaces as an
  // `ActivityFailure` whose cause is a `CancelledFailure`, and we want the
  // cancellation discriminant rather than the generic wrapper.
  if (isCancellation(error)) {
    return new ActivityCancelledError(activityName, error);
  }

  // Temporal wraps the actionable failure inside an `ActivityFailure`;
  // unwrap it so both the rehydration check and the generic fallback see
  // the leaf failure. Fall back to the wrapper if `cause` is missing so
  // callers don't lose the error identity.
  const inner = error instanceof ActivityFailure ? (error.cause ?? error) : error;

  if (inner instanceof ApplicationFailure) {
    const rehydrated = await _internal_rehydrateContractError(activityDef.errors, inner);
    if (rehydrated) {
      return rehydrated as ContractErrorUnion<Record<string, ErrorDefinition>>;
    }
  }

  const innerMessage = inner instanceof Error ? inner.message : String(inner);
  return new ActivityError(
    activityName,
    `Activity "${activityName}" failed: ${innerMessage}`,
    inner,
  );
}
