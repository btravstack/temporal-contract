/**
 * Typed wrappers around Temporal's `CancellationScope` so workflows can
 * opt into cancellation control without reaching for
 * `@temporalio/workflow` directly. The wrappers fold cancellation into
 * the same `ResultAsync<...>` shape used elsewhere in the worker
 * context — callers branch on `err(WorkflowCancelledError)` instead of
 * catching `CancelledFailure`.
 *
 * Non-cancellation errors thrown inside the scope are wrapped in a
 * {@link WorkflowScopeError} (with the original error preserved on
 * `cause`) and surfaced on the same `err(...)` channel. Together with
 * `WorkflowCancelledError` this makes the failure modes exhaustive on
 * `result.match(...)` — nothing escapes as an unhandled rejection.
 */
import { CancellationScope, isCancellation } from "@temporalio/workflow";
import { type ResultAsync, type Result, ok, err } from "neverthrow";
import { WorkflowCancelledError, WorkflowScopeError } from "./errors.js";
import { makeResultAsync } from "./internal.js";

/**
 * Run `fn` inside a cancellable Temporal scope. If the workflow (or an
 * ancestor scope) is cancelled while the function is in flight, the
 * resulting ResultAsync resolves to `err(WorkflowCancelledError)`,
 * letting callers handle cancellation explicitly — typically to perform
 * a graceful exit from the current step.
 *
 * Non-cancellation errors thrown by `fn` resolve to
 * `err(WorkflowScopeError)` (with the original error on `cause`) so
 * domain failures surface on the same typed error channel rather than
 * leaking as unhandled rejections.
 *
 * @example
 * ```ts
 * const result = await context.cancellableScope(async () => {
 *   return await context.activities.processStep(...);
 * });
 *
 * result.match(
 *   (output) => { ... },
 *   (error) => {
 *     if (error instanceof WorkflowCancelledError) {
 *       // graceful exit
 *     } else {
 *       // error instanceof WorkflowScopeError — domain failure on `cause`
 *     }
 *   },
 * );
 * ```
 */
export function cancellableScope<T>(
  fn: () => T | Promise<T>,
): ResultAsync<T, WorkflowCancelledError | WorkflowScopeError> {
  const work = async (): Promise<Result<T, WorkflowCancelledError | WorkflowScopeError>> => {
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
      return err(new WorkflowScopeError(error));
    }
  };
  // makeResultAsync is the shared safety net from `@temporal-contract/contract`
  // — `new ResultAsync(work())` does not catch, so a synchronous throw inside
  // `work` (e.g. a buggy refactor) would escape neverthrow's railway. The
  // catch-all here funnels that back into `err(WorkflowScopeError)` for
  // parity with the in-band path above.
  return makeResultAsync(work, (e) => new WorkflowScopeError(e));
}

/**
 * Run `fn` inside a non-cancellable Temporal scope. Cancellation requests
 * from outside the scope are ignored for its duration — the idiomatic way
 * to perform cleanup that must not be interrupted (e.g. releasing a
 * resource after a graceful shutdown).
 *
 * Mirrors `cancellableScope`'s `ResultAsync<...>` shape for symmetry; the
 * `err(WorkflowCancelledError)` branch only triggers when cancellation is
 * raised from inside the scope (rare). Non-cancellation errors surface as
 * `err(WorkflowScopeError)`.
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
): ResultAsync<T, WorkflowCancelledError | WorkflowScopeError> {
  const work = async (): Promise<Result<T, WorkflowCancelledError | WorkflowScopeError>> => {
    try {
      const value = await CancellationScope.nonCancellable(async () => fn());
      return ok(value);
    } catch (error) {
      if (isCancellation(error)) {
        return err(new WorkflowCancelledError(error));
      }
      return err(new WorkflowScopeError(error));
    }
  };
  return makeResultAsync(work, (e) => new WorkflowScopeError(e));
}
