/**
 * Internal helpers shared across the client package's modules.
 *
 * Not part of the public API — this module is not listed in the package's
 * `exports` map, so consumers can't import from `@temporal-contract/client/internal`.
 * In-package modules and tests import it directly via relative path.
 */
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { WorkflowFailedError as TemporalWorkflowFailedError } from "@temporalio/client";
import {
  defineSearchAttributeKey,
  type SearchAttributePair,
  TypedSearchAttributes,
  WorkflowNotFoundError as TemporalWorkflowNotFoundError,
} from "@temporalio/common";
import type { AnyWorkflowDefinition, SearchAttributeDefinition } from "@temporal-contract/contract";
import { _internal_makeAsyncResult } from "@temporal-contract/contract/result-async";
import { ok, err, type AsyncResult, type Result } from "unthrown";
import {
  RuntimeClientError,
  type TemporalFailure,
  WorkflowAlreadyStartedError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
} from "./errors.js";

/**
 * Translate the contract's typed `searchAttributes` map (declared
 * name → value) into a Temporal `TypedSearchAttributes` instance, so the
 * Temporal client honours indexing when starting the workflow.
 *
 * Workflows without a `searchAttributes` block (or callers passing no
 * values) resolve to `ok(undefined)`, matching the Temporal SDK's
 * "absent ≠ empty" semantics.
 *
 * Returns `err(RuntimeClientError)` on unknown keys. The TypeScript
 * surface already gates the happy path; the runtime check catches typed
 * escape hatches (`as never`, `as any`, raw-call interop) where a typo
 * would otherwise silently drop the attribute, leaving the workflow
 * unindexed without any signal to the caller.
 */
export function toTypedSearchAttributes(
  workflowDef: AnyWorkflowDefinition,
  workflowName: string,
  values: Record<string, unknown> | undefined,
): Result<TypedSearchAttributes | undefined, RuntimeClientError> {
  if (!values) return ok(undefined);
  // Workflows that omit the `searchAttributes` block declare none. Treat
  // that as an empty declared map so a caller passing values still hits
  // the per-key "undeclared" check below — silently dropping them would
  // re-introduce the escape-hatch gap this helper was designed to close.
  const declared = (workflowDef.searchAttributes ?? {}) as Record<
    string,
    SearchAttributeDefinition
  >;
  const pairs: SearchAttributePair[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const def = declared[name];
    if (!def) {
      return err(
        new RuntimeClientError(
          "searchAttributes",
          new Error(
            `Search attribute "${name}" is not declared on workflow "${workflowName}". ` +
              `Declared attributes: ${Object.keys(declared).join(", ") || "none"}.`,
          ),
        ),
      );
    }
    const key = defineSearchAttributeKey(name, def.kind);
    pairs.push({ key, value } as SearchAttributePair);
  }
  return ok(pairs.length > 0 ? new TypedSearchAttributes(pairs) : undefined);
}

/**
 * Wrap an async result-producing function in an `AsyncResult`, routing any
 * unanticipated rejection through unthrown's `defect` channel.
 *
 * The work function is expected to handle its own domain errors and return
 * an `err(...)` for them; a thrown exception the work didn't anticipate is an
 * *unmodeled* failure and surfaces as a defect (inspectable via
 * `result.isDefect()` / `result.cause`, re-thrown at the edge) rather than a
 * manufactured `RuntimeClientError`.
 *
 * Used by `client.ts` (workflow operations) and `schedule.ts` (schedule
 * operations) so the unexpected-rejection shape is identical across the
 * typed client surface. Delegates to `_internal_makeAsyncResult` from
 * `@temporal-contract/contract` so the same wrapper is shared between the
 * client and worker packages.
 */
export function makeResultAsync<T, E>(work: () => Promise<Result<T, E>>): AsyncResult<T, E> {
  return _internal_makeAsyncResult(work);
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
