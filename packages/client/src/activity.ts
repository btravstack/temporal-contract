/**
 * Standalone activities — Temporal's `client.activity.*`, an activity run
 * directly by a client with no workflow around it (Temporal Server ≥ 1.32).
 * The worker side needs nothing new: `declareActivitiesHandler` registers
 * every contract activity under its name on the contract's task queue, so a
 * standalone call runs the same validating wrapper.
 */
import type { ActivityDefinition, ContractDefinition } from "@temporal-contract/contract";
import { TechnicalError } from "@temporal-contract/contract/errors";
import { _internal_missingBounds } from "@temporal-contract/contract/internal";
import {
  ActivityExecutionAlreadyStartedError,
  ActivityExecutionFailedError,
  ActivityNotFoundError,
  type ActivityDescribeOptions,
  type ActivityExecutionDescription,
  type ActivityHandle,
  type ActivityOptions,
  type Client,
} from "@temporalio/client";
import { CancelledFailure, TerminatedFailure, TimeoutFailure } from "@temporalio/common";
import { type AsyncResult, Err, ErrAsync, OkAsync, P } from "unthrown";

import {
  ACTIVITY_CANCELLED_ERROR_TAG,
  ACTIVITY_EXECUTION_NOT_FOUND_ERROR_TAG,
  ACTIVITY_FAILED_ERROR_TAG,
  ACTIVITY_TERMINATED_ERROR_TAG,
  ACTIVITY_TIMEOUT_ERROR_TAG,
} from "./error-tags.js";
import {
  ActivityAlreadyStartedError,
  ActivityCancelledError,
  ActivityExecutionNotFoundError,
  ActivityFailedError,
  ActivityTerminatedError,
  ActivityTimeoutError,
  ActivityValidationError,
  type TemporalFailure,
} from "./errors.js";
import {
  call,
  lookupActivity,
  type OnRehydrationMiss,
  parseWithSchema,
  rehydrateFailedResult,
} from "./internal.js";
import type { TypedActivityStartOptions } from "./options.js";
import type { ActivityResultErrorsOf, ClientInferOutput } from "./types.js";

/**
 * Typed handle to a standalone activity execution, returned by
 * `ContractClient.startActivity` and `getActivityHandle`.
 */
export type TypedActivityHandle<TActivity extends ActivityDefinition> = {
  readonly activityId: string;
  /**
   * Run ID of the execution this handle is pinned to: the started run for
   * `startActivity` handles, the caller-provided `runId` (or `undefined`,
   * meaning the latest run) for `getActivityHandle` handles.
   */
  readonly runId: string | undefined;
  /**
   * The underlying `@temporalio/client` `ActivityHandle` — the escape hatch
   * for what the typed surface doesn't cover (`pause`, `updateOptions`, …).
   */
  readonly raw: ActivityHandle;
  /**
   * Wait for the activity's result, parsed against its output schema. A
   * failure matching one of the activity's declared errors surfaces as that
   * typed `ContractError`; a cancelled / terminated / timed-out execution as
   * the first-class `ActivityCancelledError` / `ActivityTerminatedError` /
   * `ActivityTimeoutError`; anything else as `ActivityFailedError`.
   */
  result: () => AsyncResult<ClientInferOutput<TActivity>, ActivityResultErrorsOf<TActivity>>;
  /** Describe the execution (status, attempts, timing, …). */
  describe: (
    options?: ActivityDescribeOptions,
  ) => AsyncResult<ActivityExecutionDescription, ActivityExecutionNotFoundError>;
  /** Request cancellation — cooperative: the activity must heartbeat to see it. */
  cancel: (reason?: string) => AsyncResult<void, ActivityExecutionNotFoundError>;
  /** Terminate the execution. The worker is not notified and may keep running it. */
  terminate: (reason?: string) => AsyncResult<void, ActivityExecutionNotFoundError>;
};

/**
 * Validate, merge options, and start a standalone activity on the
 * contract's task queue. Shared by `startActivity` and `executeActivity`.
 */
export function startActivity(
  client: Client,
  contract: ContractDefinition,
  activityName: string,
  options: TypedActivityStartOptions<ActivityDefinition>,
  onRehydrationMiss: OnRehydrationMiss | undefined,
): AsyncResult<
  TypedActivityHandle<ActivityDefinition>,
  ActivityValidationError | ActivityAlreadyStartedError
> {
  const { activityId, args, ...callOptions } = options as Omit<
    TypedActivityStartOptions<ActivityDefinition>,
    "args"
  > & { args?: unknown };
  // Starting from `OkAsync()` puts the lookup's and the bound check's misuse
  // throws inside the combinator's throw→defect net.
  return OkAsync().flatMap(() => {
    const definition = lookupActivity(contract, activityName);
    return parseWithSchema(
      definition.input,
      args,
      (issues) => new ActivityValidationError(activityName, "input", issues, activityId),
    )
      .flatMap(() => {
        // Shallow merge, like the worker's: the contract's options are the
        // defaults. The durations are `ms`-compatible, so the cast is safe.
        const merged = {
          ...(definition.activityOptions as Partial<ActivityOptions> | undefined),
          ...callOptions,
        };
        const missing = _internal_missingBounds(merged);
        if (missing.length > 0) {
          // oxlint-disable-next-line unthrown/no-throw -- defect-channel routing: unbounded options are a caller misconfiguration, not a modeled outcome
          throw new TechnicalError(
            `Activity "${activityName}" is missing a ${missing.join(" and a ")} bound. ` +
              "Set `startToCloseTimeout` or `scheduleToCloseTimeout` (per-attempt) and " +
              "`scheduleToCloseTimeout` or a finite positive `retry.maximumAttempts` (total), " +
              "on the contract's `activityOptions` or in the call.",
          );
        }
        return call(
          "startActivity",
          client.activity.start(activityName, {
            ...merged,
            // Contract-owned fields last, so a cast can't override them.
            id: activityId,
            taskQueue: contract.taskQueue,
            // The ORIGINAL args cross the wire — the worker parses on receive.
            args: args === undefined ? [] : [args],
          }),
          (error) =>
            error instanceof ActivityExecutionAlreadyStartedError
              ? new ActivityAlreadyStartedError(activityName, activityId, error)
              : undefined,
        );
      })
      .flatMap((handle) =>
        callOptions.idConflictPolicy === "USE_EXISTING"
          ? ensureSameActivity(handle, activityName, contract.taskQueue)
          : OkAsync(handle),
      )
      .map((handle) =>
        createTypedActivityHandle(handle, activityName, definition, onRehydrationMiss),
      );
  });
}

/**
 * Under `USE_EXISTING`, Temporal returns whichever running execution holds
 * the activity ID, whatever its type or queue. Typing that handle with this
 * activity's schemas would await an unrelated execution, so a mismatch is
 * reported as the ID being taken.
 */
function ensureSameActivity(
  handle: ActivityHandle,
  activityName: string,
  taskQueue: string,
): AsyncResult<ActivityHandle, ActivityAlreadyStartedError> {
  return call<ActivityExecutionDescription, never>(
    "activity.describe",
    handle.describe(),
    () => undefined,
  ).flatMap((description) =>
    description.activityType === activityName && description.taskQueue === taskQueue
      ? OkAsync(handle)
      : ErrAsync(new ActivityAlreadyStartedError(activityName, handle.activityId)),
  );
}

/**
 * Wrap a Temporal `ActivityHandle` in the typed, validating surface.
 */
export function createTypedActivityHandle<TActivity extends ActivityDefinition>(
  handle: ActivityHandle,
  activityName: string,
  definition: TActivity,
  onRehydrationMiss: OnRehydrationMiss | undefined,
): TypedActivityHandle<TActivity> {
  const { activityId } = handle;
  const notFound = (error: unknown) =>
    error instanceof ActivityNotFoundError
      ? new ActivityExecutionNotFoundError(activityId, handle.runId, error)
      : undefined;

  return {
    activityId,
    runId: handle.runId,
    raw: handle,
    result: () =>
      call("activity.result", handle.result(), (error) =>
        error instanceof ActivityExecutionFailedError
          ? classifyFailedActivity(activityId, error.cause)
          : notFound(error),
      )
        .flatMapErrCases((matcher) =>
          matcher
            .with(
              P.tag(ACTIVITY_FAILED_ERROR_TAG),
              (failed) =>
                rehydrateFailedResult(definition.errors, failed, onRehydrationMiss) as AsyncResult<
                  never,
                  ActivityResultErrorsOf<TActivity>
                >,
            )
            .with(
              P.tag(ACTIVITY_CANCELLED_ERROR_TAG),
              P.tag(ACTIVITY_TERMINATED_ERROR_TAG),
              P.tag(ACTIVITY_TIMEOUT_ERROR_TAG),
              P.tag(ACTIVITY_EXECUTION_NOT_FOUND_ERROR_TAG),
              (error) => Err(error),
            ),
        )
        .flatMap(
          (output) =>
            // Receive side of the result boundary: the worker transmitted its
            // original return value, so the parse happens exactly once, here.
            parseWithSchema(
              definition.output,
              output,
              (issues) => new ActivityValidationError(activityName, "output", issues, activityId),
            ) as AsyncResult<ClientInferOutput<TActivity>, ActivityValidationError>,
        ),
    describe: (options) => call("activity.describe", handle.describe(options), notFound),
    cancel: (reason) =>
      call("activity.cancel", handle.cancel(reason ?? ""), notFound).map(() => undefined),
    terminate: (reason) =>
      call("activity.terminate", handle.terminate(reason ?? ""), notFound).map(() => undefined),
  };
}

/**
 * Classify the `cause` of Temporal's `ActivityExecutionFailedError`. A
 * standalone activity's failure arrives unwrapped (no `ActivityFailure`
 * around it, unlike inside a workflow), so the outcome failures are the
 * cause itself.
 */
function classifyFailedActivity(
  activityId: string,
  cause: Error | undefined,
): ActivityFailedError | ActivityCancelledError | ActivityTerminatedError | ActivityTimeoutError {
  if (cause instanceof CancelledFailure) return new ActivityCancelledError(activityId, cause);
  if (cause instanceof TerminatedFailure) return new ActivityTerminatedError(activityId, cause);
  if (cause instanceof TimeoutFailure) return new ActivityTimeoutError(activityId, cause);
  return new ActivityFailedError(activityId, cause as TemporalFailure | undefined);
}
