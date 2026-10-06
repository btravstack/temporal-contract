import type { ErrorDefinition } from "@temporal-contract/contract";
import { ApplicationFailure, CancelledFailure } from "@temporalio/common";
import type { AsyncResult } from "unthrown";

import { contractErrorToApplicationFailure, isContractError } from "./contract-errors.js";
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
 * Prefer this to unthrown's `.getOrThrow()`. `getOrThrow` throws the
 * `ActivityError` / `ActivityCancelledError` *wrapper* itself, which is a
 * `TaggedError` and NOT a `TemporalFailure` — Temporal would retry it as a
 * workflow-TASK failure forever. `declareWorkflow` maps it at the boundary
 * (see {@link toTemporalFailure}), but code in between sees the wrapper. This
 * helper re-raises the *original* Temporal failure that
 * `classifyActivityError` observed, right here — exactly what would have
 * escaped the workflow before activity calls returned `AsyncResult`.
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
 * A **rehydrated** contract error (a `ContractError` read back from an
 * activity's or child workflow's declared `errors`) re-raises its `cause` —
 * the `ApplicationFailure` Temporal put on the wire — so the workflow fails
 * with the callee's real typed failure. Any other `ContractError` is rethrown
 * as-is, and `declareWorkflow` converts it against the workflow's own
 * `errors` map. For a declared error the client therefore sees
 * `WorkflowFailedError.cause` as a bare `ApplicationFailure`, never wrapped in
 * Temporal's `ActivityFailure` / `ChildWorkflowFailure` — unlike the
 * `ActivityError` path above, which preserves the wrapper.
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
  // anticipate). It goes through the same classification rather than being
  // rethrown unclassified: a defect's `cause` can itself be one of the shapes
  // handled there (e.g. an `ActivityError` thrown instead of returned).
  // oxlint-disable-next-line unthrown/no-throw -- deliberate re-raise: Temporal must see the original failure to classify the workflow outcome
  throw toTemporalFailure(settled.isErr() ? settled.error : settled.cause);
}

/**
 * The value to throw so Temporal sees `error` as what it really is — the one
 * classification shared by {@link propagateFailure} and every workflow-sandbox
 * boundary (`declareWorkflow`'s implementation, signal and update handlers).
 *
 * This package's tagged errors (`ActivityError`, `ChildWorkflowError`, the
 * `*CancelledError`s, `ChildWorkflowNotFoundError`) are not `TemporalFailure`s;
 * thrown as-is — `throw result.error`, `.getOrThrow()` — Temporal would retry
 * the workflow task forever instead of failing the workflow. Each maps to the
 * failure it carries (see {@link propagateFailure} for the per-class rules); a
 * failure detected before any Temporal call (no `cause`) becomes a terminal
 * {@link ContractMisuseError}, a cause-less cancellation a fresh
 * `CancelledFailure`.
 *
 * A rehydrated `ContractError` (its `cause` is the `ApplicationFailure` it was
 * read from) maps to that failure. Any other `ContractError` is returned as-is
 * for the caller to convert against the declaring scope's `errors` map.
 * Everything else — a `TemporalFailure`, `ContinueAsNew`, an unknown throw —
 * is returned untouched.
 */
export function toTemporalFailure(error: unknown): unknown {
  if (error instanceof ActivityError) {
    return error.originalFailure ?? error.cause ?? new ContractMisuseError(error.message);
  }
  if (
    error instanceof ActivityCancelledError ||
    error instanceof ChildWorkflowCancelledError ||
    error instanceof WorkflowCancelledError
  ) {
    return error.cause ?? new CancelledFailure(error.message);
  }
  if (error instanceof ChildWorkflowError) {
    return error.cause ?? new ContractMisuseError(error.message);
  }
  if (error instanceof ChildWorkflowNotFoundError) {
    return new ContractMisuseError(error.message);
  }
  if (
    isContractError(error) &&
    error.cause instanceof ApplicationFailure &&
    error.cause.type === error.errorName
  ) {
    return error.cause;
  }
  return error;
}

/**
 * {@link toTemporalFailure}, plus the conversion of a `ContractError` thrown
 * by workflow code (`throw context.errors.X(...)`) into its `ApplicationFailure`
 * wire shape against the workflow's own declared `errors` — what every
 * workflow-sandbox boundary throws in place of the caught value.
 */
export async function toWorkflowFailure(
  error: unknown,
  declaredErrors: Record<string, ErrorDefinition> | undefined,
  scopeLabel: string,
): Promise<unknown> {
  const failure = toTemporalFailure(error);
  return isContractError(failure)
    ? await contractErrorToApplicationFailure(failure, declaredErrors, scopeLabel)
    : failure;
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
