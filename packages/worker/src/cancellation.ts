/**
 * Typed wrappers around Temporal's `CancellationScope` so workflows can
 * opt into cancellation control without reaching for
 * `@temporalio/workflow` directly. The wrappers fold cancellation into
 * the same `AsyncResult<...>` shape used elsewhere in the worker
 * context — callers branch on `Err(WorkflowCancelledError)` instead of
 * catching `CancelledFailure`.
 *
 * Non-cancellation errors thrown inside the scope are *unmodeled* failures:
 * they ride unthrown's `defect` channel (re-thrown at the edge / inspectable
 * via `result.isDefect()` and `result.cause`) rather than a typed `Err(...)`,
 * keeping the modeled error channel to the single anticipated outcome —
 * cancellation.
 */
import { CancellationScope, isCancellation } from "@temporalio/workflow";
import { type AsyncResult, type Result, Ok, Err } from "unthrown";
import { WorkflowCancelledError } from "./errors.js";
import { makeAsyncResult } from "./internal.js";

/**
 * Run `fn` inside a cancellable Temporal scope. If the workflow (or an
 * ancestor scope) is cancelled while the function is in flight, the
 * resulting AsyncResult resolves to `Err(WorkflowCancelledError)`,
 * letting callers handle cancellation explicitly — typically to perform
 * a graceful exit from the current step.
 *
 * Non-cancellation errors thrown by `fn` are unmodeled failures: they surface
 * on the `defect` channel rather than as a typed `Err(...)`, so a genuine bug
 * is not silently treated as an anticipated domain outcome.
 *
 * @example
 * ```ts
 * const result = await context.cancellableScope(async () => {
 *   return await context.activities.processStep(...);
 * });
 *
 * result.match({
 *   ok: (output) => { ... },
 *   err: (error) => {
 *     // error instanceof WorkflowCancelledError — graceful exit
 *   },
 *   defect: (cause) => {
 *     // a non-cancellation failure thrown inside the scope (a bug)
 *   },
 * });
 * ```
 */
export function cancellableScope<T>(
  fn: () => T | Promise<T>,
): AsyncResult<T, WorkflowCancelledError> {
  const work = async (): Promise<Result<T, WorkflowCancelledError>> => {
    try {
      // Wrap so synchronous returns satisfy CancellationScope.cancellable's
      // `() => Promise<T>` signature without forcing every caller to write
      // `async () => ...` for purely synchronous bodies.
      const value = await CancellationScope.cancellable(async () => fn());
      return Ok(value);
    } catch (error) {
      if (isCancellation(error)) {
        return Err(new WorkflowCancelledError(error));
      }
      // Non-cancellation throw → re-throw so `makeAsyncResult`'s boundary
      // routes it through the `defect` channel as an unmodeled failure.
      throw error;
    }
  };
  return makeAsyncResult(work);
}

/**
 * Run `fn` inside a non-cancellable Temporal scope. Cancellation requests
 * from outside the scope are ignored for its duration — the idiomatic way
 * to perform cleanup that must not be interrupted (e.g. releasing a
 * resource after a graceful shutdown).
 *
 * Mirrors `cancellableScope`'s `AsyncResult<...>` shape for symmetry; the
 * `Err(WorkflowCancelledError)` branch only triggers when cancellation is
 * raised from inside the scope (rare). Non-cancellation errors surface on the
 * `defect` channel.
 *
 * @example
 * ```ts
 * await context.nonCancellableScope(async () => {
 *   await context.activities.releaseResources(...);
 * });
 * ```
 */
export function nonCancellableScope<T>(
  fn: () => T | Promise<T>,
): AsyncResult<T, WorkflowCancelledError> {
  const work = async (): Promise<Result<T, WorkflowCancelledError>> => {
    try {
      const value = await CancellationScope.nonCancellable(async () => fn());
      return Ok(value);
    } catch (error) {
      if (isCancellation(error)) {
        return Err(new WorkflowCancelledError(error));
      }
      throw error;
    }
  };
  return makeAsyncResult(work);
}
