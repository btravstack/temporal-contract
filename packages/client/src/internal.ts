/**
 * Internal helpers shared across the client package's modules.
 *
 * Not part of the public API — this module is not listed in the package's
 * `exports` map, so consumers can't import from `@temporal-contract/client/internal`.
 * In-package modules and tests import it directly via relative path.
 */
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { WorkflowFailedError as TemporalWorkflowFailedError } from "@temporalio/client";
import { WorkflowNotFoundError as TemporalWorkflowNotFoundError } from "@temporalio/common";
import { _internal_makeResultAsync } from "@temporal-contract/contract/result-async";
import type { ResultAsync, Result } from "neverthrow";
import {
  RuntimeClientError,
  type TemporalFailure,
  WorkflowAlreadyStartedError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
} from "./errors.js";

/**
 * Wrap an async result-producing function in a `ResultAsync`, catching any
 * unhandled rejection as a `RuntimeClientError("unexpected", error)`.
 *
 * The work function is expected to handle its own domain errors and return
 * an `err(...)` for them; the catch here is a safety net for thrown
 * exceptions the work didn't anticipate.
 *
 * Used by `client.ts` (workflow operations) and `schedule.ts` (schedule
 * operations) so the unexpected-rejection shape is identical across the
 * typed client surface. Delegates to `_internal_makeResultAsync` from
 * `@temporal-contract/contract` so the same wrapper is shared between the
 * client and worker packages.
 */
export function makeResultAsync<T, E>(
  work: () => Promise<Result<T, E>>,
): ResultAsync<T, E | RuntimeClientError> {
  return _internal_makeResultAsync<T, E | RuntimeClientError>(
    work,
    (e) => new RuntimeClientError("unexpected", e),
  );
}

/**
 * Map a thrown error from `client.workflow.start` / `signalWithStart` into
 * the discriminated union surfaced by the typed client. Specifically
 * recognizes Temporal's `WorkflowExecutionAlreadyStartedError`; everything
 * else falls through to {@link RuntimeClientError}.
 */
export function classifyStartError(
  operation: string,
  error: unknown,
): WorkflowAlreadyStartedError | RuntimeClientError {
  if (error instanceof WorkflowExecutionAlreadyStartedError) {
    return new WorkflowAlreadyStartedError(error.workflowType, error.workflowId, error);
  }
  return new RuntimeClientError(operation, error);
}

/**
 * Map a thrown error from a workflow handle method (signal, query,
 * executeUpdate, terminate, cancel, describe, fetchHistory) into the
 * discriminated union surfaced by the typed client. Recognizes Temporal's
 * `WorkflowNotFoundError`; everything else falls through to
 * {@link RuntimeClientError}.
 *
 * `fallbackWorkflowId` is used when Temporal's error carries an empty
 * `workflowId` (it normalizes missing IDs to the empty string), so the
 * surfaced error always identifies the targeted execution.
 */
export function classifyHandleError(
  operation: string,
  error: unknown,
  fallbackWorkflowId: string,
): WorkflowExecutionNotFoundError | RuntimeClientError {
  if (error instanceof TemporalWorkflowNotFoundError) {
    return new WorkflowExecutionNotFoundError(
      error.workflowId || fallbackWorkflowId,
      error.runId,
      error,
    );
  }
  return new RuntimeClientError(operation, error);
}

/**
 * Map a thrown error from `handle.result()` / `client.workflow.execute()`
 * (the latter when waiting on the result phase). Recognizes Temporal's
 * `WorkflowFailedError` and `WorkflowNotFoundError`; everything else falls
 * through to {@link RuntimeClientError}.
 *
 * Temporal's `WorkflowFailedError` is itself a wrapper — the actionable
 * failure (ApplicationFailure, CancelledFailure, TerminatedFailure, etc.)
 * lives on its `cause` field. We forward that inner cause directly so
 * consumers can match `err.cause` against the underlying failure class
 * without an extra unwrap step. (If Temporal's cause is `undefined`, our
 * `cause` is too — same shape as before.)
 */
export function classifyResultError(
  operation: string,
  error: unknown,
  workflowId: string,
): WorkflowFailedError | WorkflowExecutionNotFoundError | RuntimeClientError {
  if (error instanceof TemporalWorkflowFailedError) {
    // Temporal types `cause` as `Error | undefined`, but the SDK only ever
    // populates it with a `TemporalFailure` subclass when surfacing a
    // workflow result failure. Narrow with the public union so consumers
    // can branch on the leaf failure types without an extra cast.
    return new WorkflowFailedError(workflowId, error.cause as TemporalFailure | undefined);
  }
  if (error instanceof TemporalWorkflowNotFoundError) {
    return new WorkflowExecutionNotFoundError(error.workflowId || workflowId, error.runId, error);
  }
  return new RuntimeClientError(operation, error);
}
