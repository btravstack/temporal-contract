import { ContractError } from "@temporal-contract/contract/errors";
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
 * A **declared** contract error (`ContractError`, from an activity's `errors`
 * map) is also a `TaggedError`, not a `TemporalFailure` — but, unlike
 * `ActivityError`/`ActivityCancelledError`, rethrowing it bare does NOT
 * stall the workflow: `declareWorkflow`'s own top-level catch (`workflow.ts`)
 * recognizes `error instanceof ContractError` by name and converts it via
 * `contractErrorToApplicationFailure` before Temporal ever sees it. What that
 * fallback conversion produces, though, is *wrong* here: it looks the error
 * name up on the *workflow's* declared `errors` map — not the *activity's*,
 * which is what this `ContractError` was actually rehydrated against. When
 * the name isn't also declared on the workflow (the common case, since the
 * error is declared on the activity), the workflow still fails terminally,
 * but with a misleading `ContractErrorDataValidationError: Error "X" is not
 * declared on workflow "…"` instead of the activity's real, typed failure.
 * This branch exists to fix that *misclassification*, not to prevent a
 * stall: it re-raises `ContractError.cause`, the original `ApplicationFailure`
 * Temporal actually put on the wire, so the workflow fails with the real
 * failure instead of a confusing wrong-map error message.
 *
 * **Fidelity nuance, stated plainly:** for a declared error this means the
 * client sees `WorkflowFailedError.cause` as a bare `ApplicationFailure`,
 * never wrapped in Temporal's `ActivityFailure` — unlike the `ActivityError`
 * path above, which preserves the `ActivityFailure` wrapper exactly. This is
 * a deliberate *asymmetry*, not an inevitability: `classifyActivityError`
 * still holds the original wrapper (its `error` parameter — the same value
 * it hands `ActivityError` as `originalFailure`) at the point it builds a
 * `ContractError`, but `_internal_rehydrateContractError` is only handed the
 * already-unwrapped failure, so the wrapper is never threaded through the
 * rehydration path. A parallel `originalFailure`-style retention on
 * `ContractError` would close this gap; that was deliberately left out of
 * this task's scope.
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
  if (error instanceof ContractError) {
    // oxlint-disable-next-line unthrown/no-throw -- deliberate re-raise: re-raise the original ApplicationFailure so the workflow fails with the activity's real declared error, not declareWorkflow's misleading "not declared on workflow" fallback (see doc comment)
    throw error.cause ?? error;
  }
  // oxlint-disable-next-line unthrown/no-throw -- deliberate re-raise: an unmodeled error/defect value is rethrown unchanged
  throw error;
}
