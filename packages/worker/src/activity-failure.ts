import type { AsyncResult } from "unthrown";

import { ActivityCancelledError, ActivityError } from "./errors.js";

/**
 * Await an activity call and return its value, re-raising the failure so
 * **Temporal** decides the workflow's fate — the workflow-side equivalent of
 * "let it fail".
 *
 * Use this instead of unthrown's `.getOrThrow()`. `getOrThrow` throws the
 * `ActivityError` / `ActivityCancelledError` *wrapper* itself, which is a
 * `TaggedError` and NOT a `TemporalFailure`. Temporal treats a
 * non-`TemporalFailure` thrown from workflow code as a workflow-TASK failure
 * and retries it indefinitely, so the workflow never fails — it stalls until
 * its execution timeout. This helper instead re-raises the *original*
 * Temporal failure that `classifyActivityError` observed, which is exactly
 * what would have escaped the workflow before activity calls returned
 * `AsyncResult`.
 *
 * Two things are preserved on `ActivityError`, and they are NOT
 * interchangeable:
 * - `cause` — the *unwrapped* actionable failure (Temporal's
 *   `ActivityFailure` wrapper seen through). This is documented, caller-facing
 *   behavior that existing consumers narrow on, and this helper does not
 *   change it.
 * - `originalFailure` — the value exactly as `classifyActivityError` caught
 *   it, *before* that unwrap (typically the `ActivityFailure` wrapper
 *   itself). This helper re-raises `originalFailure` (falling back to
 *   `cause`, then the wrapper) so the failure Temporal observes here is
 *   byte-for-byte what it would have observed had the activity call thrown
 *   directly — rethrowing `cause` instead would hand Temporal a bare
 *   `ApplicationFailure` where it previously saw an `ActivityFailure`,
 *   changing what a caller further up (e.g. the client's
 *   `WorkflowFailedError.cause`) sees.
 *
 * `ActivityCancelledError` has no separate `originalFailure`: cancellation is
 * detected *before* the unwrap, so its `cause` already holds the pre-unwrap
 * original failure.
 *
 * A failure with nothing preserved at all rethrows the wrapper, so the error
 * identity is never lost.
 */
export async function propagateActivityFailure<T, E>(result: AsyncResult<T, E>): Promise<T> {
  const settled = await result;
  if (settled.isOk()) {
    return settled.value;
  }

  // A `Defect` is an unmodeled failure (a bug this library didn't
  // anticipate) — rethrow its cause unchanged rather than trying to classify
  // it as an activity failure.
  const error: unknown = settled.isErr() ? settled.error : settled.cause;

  if (error instanceof ActivityError) {
    // oxlint-disable-next-line unthrown/no-throw -- deliberate re-raise: Temporal must see the original failure (pre-unwrap) to classify the workflow outcome exactly as it would have if the activity call still threw directly
    throw error.originalFailure ?? error.cause ?? error;
  }
  if (error instanceof ActivityCancelledError) {
    // oxlint-disable-next-line unthrown/no-throw -- deliberate re-raise: `cause` already holds the pre-unwrap original failure for cancellation (see ActivityCancelledError's doc comment)
    throw error.cause ?? error;
  }
  // oxlint-disable-next-line unthrown/no-throw -- deliberate re-raise: an unmodeled error/defect value is rethrown unchanged
  throw error;
}
