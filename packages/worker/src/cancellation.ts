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
import { type AsyncResult, Ok, Err } from "unthrown";

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
 * import { P } from "unthrown";
 * import { propagateActivityFailure } from "@temporal-contract/worker/workflow";
 *
 * // `fn`'s return value becomes the scope's `T` verbatim — an un-awaited
 * // `context.activities.processStep(...)` would make `T` the AsyncResult
 * // itself (it has no `isOk`/`isErr`/`.value`), not the activity's output.
 * // `propagateActivityFailure` awaits it and hands the scope a plain value.
 * const result = await context.cancellableScope(async () => {
 *   return await propagateActivityFailure(context.activities.processStep(...));
 * });
 *
 * result.match({
 *   ok: (output) => { ... },
 *   errCases: (matcher) =>
 *     matcher.with(P.tag("@temporal-contract/WorkflowCancelledError"), (error) => {
 *       // error instanceof WorkflowCancelledError — graceful exit
 *     }),
 *   defect: (cause) => {
 *     // a non-cancellation failure thrown inside the scope (a bug) — or,
 *     // via propagateActivityFailure, a non-cancellation activity failure
 *   },
 * });
 * ```
 */
export function cancellableScope<T>(
  fn: () => T | Promise<T>,
): AsyncResult<T, WorkflowCancelledError> {
  const work = async () => {
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
      // oxlint-disable-next-line unthrown/no-throw -- cancellation-scope rethrow: the throw IS the defect-channel routing through makeAsyncResult's boundary
      throw error;
    }
  };
  return makeAsyncResult<T, WorkflowCancelledError>(work);
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
 * import { propagateActivityFailure } from "@temporal-contract/worker/workflow";
 *
 * // Capture the scope's OWN AsyncResult — a bare `await` would silently
 * // discard a defect thrown inside the callback, along with the activity's
 * // own un-awaited AsyncResult if `fn` returned it directly.
 * const released = await context.nonCancellableScope(() =>
 *   propagateActivityFailure(context.activities.releaseResources(...)),
 * );
 * if (released.isDefect()) {
 *   throw released.cause;
 * }
 * ```
 */
export function nonCancellableScope<T>(
  fn: () => T | Promise<T>,
): AsyncResult<T, WorkflowCancelledError> {
  const work = async () => {
    try {
      const value = await CancellationScope.nonCancellable(async () => fn());
      return Ok(value);
    } catch (error) {
      if (isCancellation(error)) {
        return Err(new WorkflowCancelledError(error));
      }
      // oxlint-disable-next-line unthrown/no-throw -- cancellation-scope rethrow: the throw IS the defect-channel routing through makeAsyncResult's boundary
      throw error;
    }
  };
  return makeAsyncResult<T, WorkflowCancelledError>(work);
}
