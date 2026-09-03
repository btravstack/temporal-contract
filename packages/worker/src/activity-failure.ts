import { ContractError } from "@temporal-contract/contract/errors";
import type { AsyncResult } from "unthrown";

import {
  ActivityCancelledError,
  ActivityError,
  ChildWorkflowCancelledError,
  ChildWorkflowError,
  ChildWorkflowNotFoundError,
  ContractMisuseError,
  rethrowCancellation,
  WorkflowCancelledError,
} from "./errors.js";

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
 *
 * **Not just activity calls** — hence the name. The same
 * non-`TemporalFailure`-stall hazard applies to `context.executeChildWorkflow` / `context.startChildWorkflow`
 * (`ChildWorkflowError`, `ChildWorkflowCancelledError`) and to
 * `context.cancellableScope` / `context.nonCancellableScope`
 * (`WorkflowCancelledError`, whose `cause` holds the original
 * `CancelledFailure`). This helper accepts any of those too — `E` is
 * intentionally unconstrained so a bare `throw error` at the bottom doesn't
 * quietly stall the workflow for a union this module didn't anticipate.
 *
 * `ChildWorkflowCancelledError` mirrors `ActivityCancelledError`: every
 * construction site (`classifyChildWorkflowError`) supplies `cause` as the
 * pre-unwrap cancellation failure Temporal produced, so it is always safe to
 * re-raise. `ChildWorkflowError`, however, does NOT uniformly mirror
 * `ActivityError`: `classifyChildWorkflowError`'s own construction sites do
 * set `cause` to the unwrapped actionable failure, but three OTHER
 * construction sites in `child-workflow.ts` — input validation, output
 * validation, and signal-input validation — build a `ChildWorkflowError`
 * with no `cause` at all, because those failures are detected locally
 * (a schema mismatch) before any Temporal call happens, so there is no
 * Temporal-observed failure to carry. Re-raising the bare `TaggedError` in
 * that case would reproduce the exact stall this helper exists to prevent,
 * so when `cause` is absent this helper converts it to a `ContractMisuseError`
 * instead — the same treatment `ChildWorkflowNotFoundError` gets below.
 *
 * `ChildWorkflowNotFoundError` is the other case with no `cause` to
 * rethrow: it fires *before* any Temporal call, when the target contract
 * doesn't declare the child workflow name at all — a deterministic
 * programmer bug, not a Temporal-observed failure. It is converted to a
 * `ContractMisuseError` (a non-retryable `ApplicationFailure`) instead, so
 * it still fails the workflow terminally rather than stalling it.
 */
export async function propagateFailure<T, E>(result: AsyncResult<T, E>): Promise<T> {
  const settled = await result;
  if (settled.isOk()) {
    return settled.value;
  }

  // A `Defect` is an unmodeled failure (a bug this library didn't
  // anticipate). It falls into the same classification chain below rather
  // than being rethrown unclassified: a defect's `cause` can itself be one
  // of the shapes handled here (e.g. an `ActivityError` thrown instead of
  // returned), and that shape deserves the same re-raise treatment whether
  // it arrived via `Err` or `Defect`.
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
  if (error instanceof ChildWorkflowCancelledError) {
    // oxlint-disable-next-line unthrown/no-throw -- deliberate re-raise: mirrors ActivityCancelledError — `cause` is the pre-unwrap cancellation failure Temporal originally produced
    throw error.cause ?? error;
  }
  if (error instanceof ChildWorkflowError) {
    if (error.cause !== undefined) {
      // oxlint-disable-next-line unthrown/no-throw -- deliberate re-raise: mirrors ActivityError — `cause` is the unwrapped actionable failure Temporal originally produced
      throw error.cause;
    }
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: the input/output/signal-input validation sites in child-workflow.ts construct ChildWorkflowError with no cause at all (a deterministic contract-misuse bug, not a Temporal-observed failure), so there is no pre-existing TemporalFailure to re-raise (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(error.message);
  }
  if (error instanceof WorkflowCancelledError) {
    // oxlint-disable-next-line unthrown/no-throw -- deliberate re-raise: `cause` holds the original CancelledFailure the scope observed (see cancellableScope/nonCancellableScope)
    throw error.cause ?? error;
  }
  if (error instanceof ChildWorkflowNotFoundError) {
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: this is a deterministic contract-misuse bug, not a Temporal-observed failure, so there is no pre-existing TemporalFailure to re-raise (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(error.message);
  }
  // oxlint-disable-next-line unthrown/no-throw -- deliberate re-raise: an unmodeled error/defect value is rethrown unchanged
  throw error;
}

/**
 * Await a call whose failure is **not** worth ending the workflow over — a
 * notification, a metric, an audit write — and hand that failure to
 * `onFailure` instead. Returns the value on success and `undefined` on
 * failure, so a caller that wants the value can still narrow it.
 *
 * The counterpart to {@link propagateFailure}: that one says "let Temporal
 * decide", this one says "log it and carry on".
 *
 * **Cancellation is the exception, and that is the whole point of having this
 * as a helper.** A cancelled call arrives on the modeled `Err` channel like
 * any other failure, so a hand-written best-effort fold absorbs it — and a
 * workflow that absorbs its own cancellation runs to `Completed` after
 * someone asked it to stop. Every cancellation shape
 * ({@link ActivityCancelledError}, {@link ChildWorkflowCancelledError},
 * {@link WorkflowCancelledError}) is re-raised through
 * {@link rethrowCancellation} before `onFailure` is ever reached, so the
 * rule is structural instead of remembered at each call site.
 *
 * A `Defect` (an unmodeled failure — a bug) is passed to `onFailure` like any
 * other: the caller has already declared this call non-critical, and a
 * notification bug must not block an outcome that is already authoritative.
 * Reach for {@link propagateFailure} when that is not true.
 *
 * @example
 * ```ts
 * await bestEffort(
 *   context.activities.sendNotification({ customerId, subject, message }),
 *   (failure) => log.warn(`notification failed: ${String(failure)}`),
 * );
 * ```
 */
export async function bestEffort<T, E>(
  result: AsyncResult<T, E>,
  onFailure: (failure: unknown) => void,
): Promise<T | undefined> {
  const settled = await result;
  if (settled.isOk()) {
    return settled.value;
  }

  const error: unknown = settled.isErr() ? settled.error : settled.cause;

  if (
    error instanceof ActivityCancelledError ||
    error instanceof ChildWorkflowCancelledError ||
    error instanceof WorkflowCancelledError
  ) {
    rethrowCancellation(error);
  }

  onFailure(error);
  return undefined;
}
