// Entry point for activity implementations.
//
// Activities run *outside* the workflow sandbox, so they can use any
// implementation of the Result/Future pattern — we standardize on
// `@swan-io/boxed` here for its richer API. Workflow code (see workflow.ts)
// must use `@temporal-contract/boxed` instead, since it's compatible with
// Temporal's deterministic replay machinery.
import { ActivityDefinition, ContractDefinition } from "@temporal-contract/contract";
import { Future, Result } from "@swan-io/boxed";
import { ApplicationFailure } from "@temporalio/common";
import type { ApplicationFailureOptions, Duration } from "@temporalio/common";
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
 * Options for {@link ActivityError}.
 *
 * `code` is preserved as the public discriminator field; at throw-time, the
 * worker translates an `ActivityError` into a Temporal `ApplicationFailure`
 * using `code` as the failure `type`, and the rest of these options as the
 * corresponding `ApplicationFailure` fields, so retry-policy decisions
 * (`nonRetryableErrorTypes`, `nonRetryable`, `nextRetryDelay`) work as
 * documented in the Temporal SDK.
 */
export type ActivityErrorOptions = {
  /**
   * Underlying cause. Stored on the standard `Error.cause` property; if it's
   * an `Error` instance, it is also passed through to the resulting
   * `ApplicationFailure.cause`.
   */
  cause?: unknown;
  /**
   * When `true`, signals Temporal to skip retries for this failure regardless
   * of the activity's retry policy. Use this for permanent, deterministic
   * failures (e.g. validation errors, permission denied) where retrying would
   * never succeed.
   *
   * @default false
   */
  nonRetryable?: boolean;
  /**
   * Structured details attached to the failure. Serialized by the worker's
   * payload converter and surfaced on the Temporal side.
   */
  details?: unknown[];
  /**
   * Override the delay until the next retry. Subject to the activity's retry
   * policy maximums.
   */
  nextRetryDelay?: Duration;
};

/**
 * Domain error type for activity implementations.
 *
 * `ActivityError` is the convention for surfacing failures from typed-contract
 * activities — the activity returns `Result.Error(new ActivityError(...))`,
 * the worker converts it to an `ApplicationFailure` at throw-time, and
 * Temporal honors any retry-policy directives encoded in the options.
 *
 * If you already construct `ApplicationFailure` directly elsewhere in your
 * codebase (for cross-SDK consistency, say), you can return that from the
 * `Result.Error` branch as well — the worker forwards `ApplicationFailure`
 * instances unchanged.
 *
 * @example
 * ```ts
 * // Retryable (default) — Temporal retries per the activity's retry policy.
 * return Future.value(Result.Error(
 *   new ActivityError("PAYMENT_GATEWAY_TIMEOUT", "Gateway did not respond", { cause: err }),
 * ));
 *
 * // Non-retryable — Temporal stops retrying immediately.
 * return Future.value(Result.Error(
 *   new ActivityError("PAYMENT_DECLINED", "Card was declined", { nonRetryable: true }),
 * ));
 * ```
 */
export class ActivityError extends Error {
  readonly code: string;
  readonly nonRetryable: boolean;
  readonly details: readonly unknown[];
  readonly nextRetryDelay: Duration | undefined;

  constructor(code: string, message: string, options: ActivityErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ActivityError";
    this.code = code;
    this.nonRetryable = options.nonRetryable ?? false;
    this.details = options.details ?? [];
    this.nextRetryDelay = options.nextRetryDelay;
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ActivityError);
    }
  }
}

/**
 * Convert an `ActivityError` to a Temporal `ApplicationFailure` so the worker
 * propagates retry-policy metadata (`type`, `nonRetryable`, `details`,
 * `nextRetryDelay`, `cause`) faithfully across the activity boundary.
 *
 * The original `ActivityError`'s stack trace is copied onto the resulting
 * `ApplicationFailure` so debug output points back at the activity
 * implementation site (where the user constructed the error) rather than the
 * wrapper boundary in this file.
 */
function activityErrorToApplicationFailure(error: ActivityError): ApplicationFailure {
  const options: ApplicationFailureOptions = {
    message: error.message,
    type: error.code,
    nonRetryable: error.nonRetryable,
  };
  if (error.details.length > 0) options.details = [...error.details];
  if (error.nextRetryDelay !== undefined) options.nextRetryDelay = error.nextRetryDelay;
  if (error.cause instanceof Error) options.cause = error.cause;
  const failure = ApplicationFailure.create(options);
  if (error.stack !== undefined) {
    failure.stack = error.stack;
  }
  return failure;
}

/**
 * Error variants accepted on the `Result.Error` branch of an activity
 * implementation.
 *
 * `ActivityError` is the recommended convention; `ApplicationFailure` is
 * accepted directly for parity with non-typed-contract activities and for
 * consumers who already build their own `ApplicationFailure` instances.
 */
export type ActivityFailure = ActivityError | ApplicationFailure;

/**
 * Activity implementation using Future/Result pattern
 *
 * Returns Future<Result<Output, ActivityFailure>> for explicit error handling
 * instead of throwing exceptions. The error variant accepts either an
 * {@link ActivityError} (preferred) or a Temporal {@link ApplicationFailure}
 * passed through as-is.
 */
type BoxedActivityImplementation<TActivity extends ActivityDefinition> = (
  args: WorkerInferInput<TActivity>,
) => Future<Result<WorkerInferOutput<TActivity>, ActivityFailure>>;

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
 * - Result<T, ActivityFailure> pattern for explicit error handling
 *   (`ActivityFailure = ActivityError | ApplicationFailure`)
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
 *     // Wrap technical errors in ActivityError. The wrapper translates them
 *     // into Temporal `ApplicationFailure`s at the boundary, so retry-policy
 *     // metadata (`nonRetryable`, `details`, `nextRetryDelay`) is honored.
 *     sendEmail: (args) => {
 *       return Future.make(async resolve => {
 *         try {
 *           await emailService.send(args);
 *           resolve(Result.Ok({ sent: true }));
 *         } catch (error) {
 *           resolve(Result.Error(
 *             new ActivityError(
 *               'EMAIL_SEND_FAILED',
 *               'Failed to send email',
 *               { cause: error }
 *             )
 *           ));
 *         }
 *       });
 *     },
 *
 *     // For permanent failures, set `nonRetryable: true` so Temporal stops
 *     // retrying immediately:
 *     chargeCard: ({ amount }) =>
 *       Future.value(Result.Error(
 *         new ActivityError('CARD_DECLINED', 'Card was declined', { nonRetryable: true })
 *       )),
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
    activityImpl: (args: unknown) => Future<Result<unknown, ActivityFailure>>,
  ) {
    return async (...args: unknown[]) => {
      const input = extractHandlerInput(args);

      // Validate input
      const inputResult = await activityDef.input["~standard"].validate(input);
      if (inputResult.issues) {
        throw new ActivityInputValidationError(activityName, inputResult.issues);
      }

      // Execute boxed activity (returns Future<Result<T, ActivityFailure>>)
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
      }

      // Throw the failure for Temporal. `ApplicationFailure` instances are
      // forwarded as-is; `ActivityError` is converted so the worker can
      // attach `nonRetryable`/`type`/`details`/`nextRetryDelay` to the
      // outgoing failure.
      const failure = result.error;
      if (failure instanceof ActivityError) {
        throw activityErrorToApplicationFailure(failure);
      }
      throw failure;
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
        impl as (args: unknown) => Future<Result<unknown, ActivityFailure>>,
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
          impl as (args: unknown) => Future<Result<unknown, ActivityFailure>>,
        );
      }
    }
  }

  return wrappedActivities;
}
