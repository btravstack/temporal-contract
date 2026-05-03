// Entry point for activity implementations.
//
// Activities run *outside* the workflow sandbox, so they can use any
// implementation of the Result/Future pattern — we standardize on
// `@swan-io/boxed` here for its richer API. Workflow code (see workflow.ts)
// must use `@temporal-contract/boxed` instead, since it's compatible with
// Temporal's deterministic replay machinery.
import { ActivityDefinition, ContractDefinition } from "@temporal-contract/contract";
import { Future, Result } from "@swan-io/boxed";
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
} from "./errors.js";

/**
 * Activity error class that should be used to wrap all technical exceptions
 * Forces proper error handling and enables retry policies
 */
export class ActivityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ActivityError";
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ActivityError);
    }
  }
}

/**
 * Activity implementation using Future/Result pattern
 *
 * Returns Future<Result<Output, ActivityError>> for explicit error handling instead of throwing exceptions.
 * All errors must be wrapped in ActivityError to enable proper retry policies.
 */
type BoxedActivityImplementation<TActivity extends ActivityDefinition> = (
  args: WorkerInferInput<TActivity>,
) => Future<Result<WorkerInferOutput<TActivity>, ActivityError>>;

/**
 * Map of all activity implementations for a contract (global + all workflow-specific)
 */
type ContractBoxedActivitiesImplementations<TContract extends ContractDefinition> =
  // Global activities
  (TContract["activities"] extends Record<string, ActivityDefinition>
    ? BoxedActivitiesImplementations<TContract["activities"]>
    : {}) &
    // All workflow-specific activities merged
    {
      [TWorkflow in keyof TContract["workflows"]]: TContract["workflows"][TWorkflow]["activities"] extends Record<
        string,
        ActivityDefinition
      >
        ? BoxedActivitiesImplementations<TContract["workflows"][TWorkflow]["activities"]>
        : {};
    };

type BoxedActivitiesImplementations<TActivities extends Record<string, ActivityDefinition>> = {
  [K in keyof TActivities]: BoxedActivityImplementation<TActivities[K]>;
};

/**
 * Options for creating activities handler
 */
type DeclareActivitiesHandlerOptions<TContract extends ContractDefinition> = {
  contract: TContract;
  activities: ContractBoxedActivitiesImplementations<TContract>;
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
 * Activities handler ready for Temporal Worker
 *
 * Flat structure: all activities (global + all workflow-specific) are at the root level
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
 * Create a typed activities handler with automatic validation and Result pattern
 *
 * This wraps all activity implementations with:
 * - Validation at network boundaries
 * - Result<T, ActivityError> pattern for explicit error handling
 * - Automatic conversion from Result to Promise (throwing on Error)
 *
 * TypeScript ensures ALL activities (global + workflow-specific) are implemented.
 *
 * Use this to create the activities object for the Temporal Worker.
 *
 * @example
 * ```ts
 * import { declareActivitiesHandler, ActivityError } from '@temporal-contract/worker/activity';
 * import { Result, Future } from '@swan-io/boxed';
 * import myContract from './contract';
 *
 * export const activities = declareActivitiesHandler({
 *   contract: myContract,
 *   activities: {
 *     // Activity returns Result instead of throwing
 *     // All technical exceptions must be wrapped in ActivityError for retry policies
 *     sendEmail: (args) => {
 *       return Future.make(async resolve => {
 *         try {
 *           await emailService.send(args);
 *           resolve(Result.Ok({ sent: true }));
 *         } catch (error) {
 *           // Wrap technical errors in ActivityError to enable retries
 *           resolve(Result.Error(
 *             new ActivityError(
 *               'EMAIL_SEND_FAILED',
 *               'Failed to send email',
 *               error // Original error as cause for debugging
 *             )
 *           ));
 *         }
 *       });
 *     },
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
 * The wrapper validates inputs/outputs and folds errors into the
 * `Future<Result<...>>` shape, but it does **not** hide Temporal's
 * `@temporalio/activity` runtime. Inside the body you can still call
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
    activityImpl: (args: unknown) => Future<Result<unknown, ActivityError>>,
  ) {
    return async (...args: unknown[]) => {
      const input = extractHandlerInput(args);

      // Validate input
      const inputResult = await activityDef.input["~standard"].validate(input);
      if (inputResult.issues) {
        throw new ActivityInputValidationError(activityName, inputResult.issues);
      }

      // Execute boxed activity (returns Future<Result<T, ActivityError>>)
      const futureResult = activityImpl(inputResult.value);

      // Await Future and unwrap Result
      const result = await futureResult;

      // Process result: validate output or throw error
      if (result.isOk()) {
        // Validate output on success
        const outputResult = await activityDef.output["~standard"].validate(result.value);
        if (outputResult.issues) {
          throw new ActivityOutputValidationError(activityName, outputResult.issues);
        }
        return outputResult.value;
      } else {
        // Convert Result.Error to thrown ActivityError for Temporal
        throw result.error;
      }
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
        impl as (args: unknown) => Future<Result<unknown, ActivityError>>,
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
          impl as (args: unknown) => Future<Result<unknown, ActivityError>>,
        );
      }
    }
  }

  return wrappedActivities;
}
