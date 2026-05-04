/**
 * Typed wrappers around Temporal's `CancellationScope` so workflows can
 * opt into cancellation control without reaching for
 * `@temporalio/workflow` directly. The wrappers fold cancellation into
 * the same `ResultAsync<...>` shape used elsewhere in the worker
 * context — callers branch on `err(WorkflowCancelledError)` instead of
 * catching `CancelledFailure`.
 *
 * Non-cancellation errors thrown inside the scope are *not* swallowed:
 * the ResultAsync rejects with the original error so user-domain failures
 * keep their identity.
 */
import { CancellationScope, isCancellation } from "@temporalio/workflow";
import { ResultAsync, type Result, ok, err } from "neverthrow";
import { WorkflowCancelledError } from "./errors.js";

/**
 * Run `fn` inside a cancellable Temporal scope. If the workflow (or an
 * ancestor scope) is cancelled while the function is in flight, the
 * resulting ResultAsync resolves to `err(WorkflowCancelledError)`,
 * letting callers handle cancellation explicitly — typically to perform
 * a graceful exit from the current step.
 *
 * @example
 * ```ts
 * const result = await context.cancellableScope(async () => {
 *   return await context.activities.processStep(...);
 * });
 *
 * result.match(
 *   (output) => { ... },
 *   (cancelled) => {
 *     // cancelled instanceof WorkflowCancelledError — graceful exit
 *   },
 * );
 * ```
 */
export function cancellableScope<T>(
  fn: () => T | Promise<T>,
): ResultAsync<T, WorkflowCancelledError> {
  const work = async (): Promise<Result<T, WorkflowCancelledError>> => {
    try {
      // Wrap so synchronous returns satisfy CancellationScope.cancellable's
      // `() => Promise<T>` signature without forcing every caller to write
      // `async () => ...` for purely synchronous bodies.
      const value = await CancellationScope.cancellable(async () => fn());
      return ok(value);
    } catch (error) {
      if (isCancellation(error)) {
        return err(new WorkflowCancelledError(error));
      }
      throw error;
    }
  };
  return new ResultAsync(work());
}

/**
 * Run `fn` inside a non-cancellable Temporal scope. Cancellation requests
 * from outside the scope are ignored for its duration — the idiomatic way
 * to perform cleanup that must not be interrupted (e.g. releasing a
 * resource after a graceful shutdown).
 *
 * Mirrors `cancellableScope`'s `ResultAsync<...>` shape for symmetry;
 * the `err(...)` branch only triggers when cancellation is raised from
 * inside the scope (rare).
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
): ResultAsync<T, WorkflowCancelledError> {
  const work = async (): Promise<Result<T, WorkflowCancelledError>> => {
    try {
      const value = await CancellationScope.nonCancellable(async () => fn());
      return ok(value);
    } catch (error) {
      if (isCancellation(error)) {
        return err(new WorkflowCancelledError(error));
      }
      throw error;
    }
  };
  return new ResultAsync(work());
}
