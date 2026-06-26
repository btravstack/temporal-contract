// Entry point for activity implementations.
//
// Activities run *outside* the workflow sandbox, so they use unthrown's
// `AsyncResult` directly. Workflow code (see workflow.ts) uses the same
// unthrown API — unthrown's evaluation is compatible with Temporal's
// deterministic replay machinery.
//
// Errors flow through Temporal's `ApplicationFailure` (re-exported from
// `@temporalio/common`) — it's the SDK's first-class failure shape, so we
// don't wrap it in a custom class. `ApplicationFailure` exposes
// `nonRetryable`, `type`, `details`, and `category` natively, and survives
// the activity → workflow serialization boundary unchanged.
import { ActivityDefinition, ContractDefinition } from "@temporal-contract/contract";
import type { AsyncResult } from "unthrown";
import { ApplicationFailure } from "@temporalio/common";
import { WorkerInferInput, WorkerInferOutput } from "./types.js";
import {
  ActivityDefinitionNotFoundError,
  ActivityInputValidationError,
  ActivityOutputValidationError,
} from "./errors.js";
import { extractHandlerInput } from "./internal.js";

export {
  ActivityDefinitionNotFoundError,
  ActivityInputValidationError,
  ActivityOutputValidationError,
  ValidationError,
} from "./errors.js";

// Re-export the canonical activity-failure class so consumers don't need
// a separate `@temporalio/common` import to construct one.
export { ApplicationFailure } from "@temporalio/common";

/**
 * Activity implementation using unthrown's `AsyncResult`.
 *
 * Returns `AsyncResult<Output, ApplicationFailure>` for explicit error
 * handling instead of throwing. The wrapper rethrows `err()` payloads at
 * the activity boundary; Temporal recognizes `ApplicationFailure` natively
 * and applies the configured retry policy (with `nonRetryable: true`
 * opting an instance out per-call). An unexpected throw surfaces as a
 * `defect` and is re-thrown with its original cause.
 */
type ResultActivityImplementation<TActivity extends ActivityDefinition> = (
  args: WorkerInferInput<TActivity>,
) => AsyncResult<WorkerInferOutput<TActivity>, ApplicationFailure>;

/**
 * Map of all activity implementations for a contract (global + all workflow-specific).
 *
 * **Shape note — input is nested by workflow, output is flat.** This
 * asymmetry is deliberate:
 *
 * - The implementation map you write **mirrors the contract's structure**:
 *   global activities sit at the root, workflow-local activities nest
 *   under their owning workflow's name. Mirroring the contract gives
 *   IDE autocomplete that matches `defineContract`, prevents typos that
 *   put a workflow-local activity at the global level, and makes
 *   ownership visible at definition time.
 * - The handler returned by {@link declareActivitiesHandler} (see
 *   {@link ActivitiesHandler}) is **flat** because Temporal's worker
 *   sees a single activity namespace at runtime —
 *   `proxyActivities<...>()` resolves names from one map regardless of
 *   which workflow consumes them. `defineContract` enforces no name
 *   collisions across global + workflow-local scopes, so the flat
 *   output has no ambiguity to resolve.
 *
 * In short: write nested (mirror the contract); the wrapper flattens
 * for Temporal.
 */
type ContractResultActivitiesImplementations<TContract extends ContractDefinition> =
  // Global activities
  (TContract["activities"] extends Record<string, ActivityDefinition>
    ? ResultActivitiesImplementations<TContract["activities"]>
    : {}) &
    // All workflow-specific activities merged
    {
      [TWorkflow in keyof TContract["workflows"]]: TContract["workflows"][TWorkflow]["activities"] extends Record<
        string,
        ActivityDefinition
      >
        ? ResultActivitiesImplementations<TContract["workflows"][TWorkflow]["activities"]>
        : {};
    };

type ResultActivitiesImplementations<TActivities extends Record<string, ActivityDefinition>> = {
  [K in keyof TActivities]: ResultActivityImplementation<TActivities[K]>;
};

/**
 * Options for creating activities handler
 */
type DeclareActivitiesHandlerOptions<TContract extends ContractDefinition> = {
  contract: TContract;
  activities: ContractResultActivitiesImplementations<TContract>;
};

type ActivityImplementation<TActivity extends ActivityDefinition> = (
  args: WorkerInferInput<TActivity>,
) => Promise<WorkerInferOutput<TActivity>>;

type ActivitiesImplementations<TActivities extends Record<string, ActivityDefinition>> = {
  [K in keyof TActivities]: ActivityImplementation<TActivities[K]>;
};

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

/**
 * Activities handler ready for Temporal's `Worker.create({ activities })`.
 *
 * Flat shape: every activity (global + all workflow-local) lives at the
 * root of the returned map. See the doc comment on
 * {@link ContractResultActivitiesImplementations} for why the input you
 * write is nested by workflow while this output is flat.
 */
export type ActivitiesHandler<TContract extends ContractDefinition> =
  // Global activities
  (TContract["activities"] extends Record<string, ActivityDefinition>
    ? ActivitiesImplementations<TContract["activities"]>
    : {}) &
    // All workflow-specific activities merged at root level (flat)
    UnionToIntersection<
      {
        [TWorkflow in keyof TContract["workflows"]]: TContract["workflows"][TWorkflow]["activities"] extends Record<
          string,
          ActivityDefinition
        >
          ? ActivitiesImplementations<TContract["workflows"][TWorkflow]["activities"]>
          : {};
      }[keyof TContract["workflows"]]
    >;

/**
 * Create a typed activities handler with automatic validation and Result pattern.
 *
 * This wraps all activity implementations with:
 * - Validation at network boundaries
 * - `AsyncResult<T, ApplicationFailure>` pattern for explicit error handling
 * - Automatic conversion from Result to Promise (throwing on Error)
 *
 * TypeScript ensures ALL activities (global + workflow-specific) are implemented.
 *
 * Use this to create the activities object for the Temporal Worker.
 *
 * @example
 * ```ts
 * import { declareActivitiesHandler, ApplicationFailure } from '@temporal-contract/worker/activity';
 * import { fromPromise } from 'unthrown';
 * import myContract from './contract';
 *
 * export const activities = declareActivitiesHandler({
 *   contract: myContract,
 *   activities: {
 *     // Activity returns AsyncResult instead of throwing.
 *     sendEmail: (args) =>
 *       fromPromise(
 *         emailService.send(args),
 *         (error) =>
 *           // Wrap technical errors in ApplicationFailure. `nonRetryable`
 *           // is per-instance: set it to true on permanent failures so
 *           // Temporal stops retrying immediately.
 *           ApplicationFailure.create({
 *             type: 'EMAIL_SEND_FAILED',
 *             message: 'Failed to send email',
 *             nonRetryable: false,
 *             cause: error instanceof Error ? error : undefined,
 *           }),
 *       ).map(() => ({ sent: true })),
 *   },
 * });
 *
 * // Use with Temporal Worker
 * import { Worker } from '@temporalio/worker';
 *
 * const worker = await Worker.create({
 *   workflowsPath: require.resolve('./workflows'),
 *   activities: activities,
 *   taskQueue: contract.taskQueue,
 * });
 * ```
 *
 * @remarks
 * The wrapper accepts implementations in the
 * `AsyncResult<T, ApplicationFailure>` shape and produces ordinary
 * Promise-returning Temporal handlers (`err(...)` → thrown
 * `ApplicationFailure`; `ok(...)` → output validated against the
 * contract and resolved; `defect` → original cause re-thrown). It does
 * **not** hide Temporal's
 * `@temporalio/activity` runtime: inside the body you can still call
 * `Context.current()` from `@temporalio/activity` to access heartbeats
 * (`heartbeat(details)`, `heartbeatDetails`), activity info (attempt
 * number, workflow IDs), and the async-completion task token. See the
 * "Working with the Activity Context" section of the worker
 * implementation guide for end-to-end examples.
 */
export function declareActivitiesHandler<TContract extends ContractDefinition>(
  options: DeclareActivitiesHandlerOptions<TContract>,
): ActivitiesHandler<TContract> {
  const { contract, activities } = options;

  // Prepare Temporal-compatible activities with validation and Result unwrapping
  const wrappedActivities = {} as ActivitiesHandler<TContract>;

  // Helper to create a wrapped implementation from a definition and impl
  function makeWrapped(
    activityName: string,
    activityDef: ActivityDefinition,
    activityImpl: (args: unknown) => AsyncResult<unknown, ApplicationFailure>,
  ) {
    return async (...args: unknown[]) => {
      const input = extractHandlerInput(args);

      // Validate input
      const inputResult = await activityDef.input["~standard"].validate(input);
      if (inputResult.issues) {
        throw new ActivityInputValidationError(activityName, inputResult.issues);
      }

      // Execute unthrown activity (returns AsyncResult<T, ApplicationFailure>);
      // awaiting yields a Result<T, ApplicationFailure>.
      const result = await activityImpl(inputResult.value);

      // Fold the three channels: validate output on `ok`, surface the modeled
      // `ApplicationFailure` on `err`, and re-throw a `defect`'s original cause
      // (an unexpected throw inside the activity is a bug, not a domain error).
      return result.match({
        ok: async (value) => {
          const outputResult = await activityDef.output["~standard"].validate(value);
          if (outputResult.issues) {
            throw new ActivityOutputValidationError(activityName, outputResult.issues);
          }
          return outputResult.value;
        },
        // Convert err(...) payload to thrown ApplicationFailure for Temporal.
        // Temporal recognizes this class natively and applies the configured
        // retry policy (honoring `nonRetryable: true`).
        err: (error) => {
          throw error;
        },
        // A defect is an *unanticipated* throw inside the activity. Re-throw the
        // original cause unwrapped: Temporal wraps a non-`ApplicationFailure`
        // error as `ApplicationFailure(type: "Error")` and applies the default
        // (retryable) policy — preserving the pre-unthrown behaviour where an
        // uncaught activity throw was simply retried. We deliberately do NOT
        // coerce it to `nonRetryable`: not every unexpected throw is permanent
        // (a transient I/O fault is also "unmodeled"), and forcing fail-fast
        // here would silently change retry semantics. An activity that wants a
        // permanent failure should return `err(ApplicationFailure.create({
        // nonRetryable: true }))` explicitly.
        defect: (cause) => {
          throw cause;
        },
      });
    };
  }

  // 1) Wrap global activities defined directly under contract.activities
  if (contract.activities) {
    for (const [activityName, impl] of Object.entries(activities)) {
      // Skip workflow namespaces if present at root
      if (contract.workflows && activityName in contract.workflows) {
        continue;
      }

      const activityDef = contract.activities[activityName];
      if (!activityDef) {
        throw new ActivityDefinitionNotFoundError(activityName, Object.keys(contract.activities));
      }

      // Assign wrapped global activity
      (wrappedActivities as Record<string, unknown>)[activityName] = makeWrapped(
        activityName,
        activityDef,
        impl as (args: unknown) => AsyncResult<unknown, ApplicationFailure>,
      );
    }
  }

  // 2) Wrap workflow-scoped activities at root level (flat)
  if (contract.workflows) {
    for (const [workflowName, workflowDef] of Object.entries(contract.workflows)) {
      const wfActivitiesImpl = (activities as Record<string, unknown>)[workflowName] as
        | Record<string, unknown>
        | undefined;
      if (!wfActivitiesImpl) {
        // If no implementations provided for this workflow, skip (TypeScript typing should enforce completeness for declared ones)
        continue;
      }

      const wfDefs = workflowDef.activities ?? {};

      for (const [activityName, impl] of Object.entries(wfActivitiesImpl)) {
        const activityDef = wfDefs[activityName];
        if (!activityDef) {
          throw new ActivityDefinitionNotFoundError(
            `${workflowName}.${activityName}`,
            Object.keys(wfDefs),
          );
        }

        // Assign workflow activity directly at root level (flat structure)
        (wrappedActivities as Record<string, unknown>)[activityName] = makeWrapped(
          `${workflowName}.${activityName}`,
          activityDef,
          impl as (args: unknown) => AsyncResult<unknown, ApplicationFailure>,
        );
      }
    }
  }

  return wrappedActivities;
}
