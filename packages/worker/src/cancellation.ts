/**
 * Typed wrappers around Temporal's `CancellationScope` so workflows can
 * opt into cancellation control without reaching for
 * `@temporalio/workflow` directly. The wrappers fold cancellation into
 * the same `Future<Result<...>>` shape used elsewhere in the worker
 * context — callers branch on `Result.Error(WorkflowCancelledError)`
 * instead of catching `CancelledFailure`.
 *
 * Non-cancellation errors thrown inside the scope are *not* swallowed:
 * the Future rejects with the original error so user-domain failures
 * keep their identity.
 */
import { CancellationScope, isCancellation } from "@temporalio/workflow";
import { Future, Result } from "@temporal-contract/boxed";
import { WorkflowCancelledError } from "./errors.js";

/**
 * Run `fn` inside a cancellable Temporal scope. If the workflow (or an
 * ancestor scope) is cancelled while the function is in flight, the
 * resulting Future resolves to `Result.Error(WorkflowCancelledError)`,
 * letting callers handle cancellation explicitly — typically to perform
 * a graceful exit from the current step.
 *
 * @example
 * ```ts
 * const result = await context.cancellableScope(async () => {
 *   return await context.activities.processStep(...);
 * });
 *
 * result.match({
 *   Ok: (output) => { ... },
 *   Error: (err) => {
 *     // err instanceof WorkflowCancelledError — graceful exit
 *   },
 * });
 * ```
 */
export function cancellableScope<T>(
  fn: () => Promise<T>,
): Future<Result<T, WorkflowCancelledError>> {
  return Future.fromAsync(async () => {
    try {
      const value = await CancellationScope.cancellable(fn);
      return Result.Ok(value);
    } catch (error) {
      if (isCancellation(error)) {
        return Result.Error(new WorkflowCancelledError(error));
      }
      throw error;
    }
  });
}

/**
 * Run `fn` inside a non-cancellable Temporal scope. Cancellation requests
 * from outside the scope are ignored for its duration — the idiomatic way
 * to perform cleanup that must not be interrupted (e.g. releasing a
 * resource after a graceful shutdown).
 *
 * Mirrors `cancellableScope`'s `Future<Result<...>>` shape for symmetry;
 * the `Result.Error` branch only triggers when cancellation is raised
 * from inside the scope (rare).
 *
 * @example
 * ```ts
 * await context.nonCancellableScope(async () => {
 *   await context.activities.releaseResources(...);
 * });
 * ```
 */
export function nonCancellableScope<T>(
  fn: () => Promise<T>,
): Future<Result<T, WorkflowCancelledError>> {
  return Future.fromAsync(async () => {
    try {
      const value = await CancellationScope.nonCancellable(fn);
      return Result.Ok(value);
    } catch (error) {
      if (isCancellation(error)) {
        return Result.Error(new WorkflowCancelledError(error));
      }
      throw error;
    }
  });
}
