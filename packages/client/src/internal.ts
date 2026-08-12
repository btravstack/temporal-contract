/**
 * Internal helpers shared across the client package's modules.
 *
 * Not part of the public API — this module is not listed in the package's
 * `exports` map, so consumers can't import from `@temporal-contract/client/internal`.
 * In-package modules and tests import it directly via relative path.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AnyWorkflowDefinition, SearchAttributeDefinition } from "@temporal-contract/contract";
import { type AnyContractError } from "@temporal-contract/contract/errors";
import {
  _internal_makeAsyncResult,
  _internal_rehydrateContractError,
} from "@temporal-contract/contract/internal";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import {
  QueryNotRegisteredError,
  WorkflowFailedError as TemporalWorkflowFailedError,
  WorkflowUpdateFailedError,
} from "@temporalio/client";
import {
  ScheduleAlreadyRunning,
  ScheduleNotFoundError as TemporalScheduleNotFoundError,
} from "@temporalio/client";
import {
  ApplicationFailure,
  CancelledFailure,
  defineSearchAttributeKey,
  type SearchAttributePair,
  TerminatedFailure,
  TimeoutFailure,
  TypedSearchAttributes,
  WorkflowNotFoundError as TemporalWorkflowNotFoundError,
} from "@temporalio/common";
import { type AsyncResult, Err, fromSafePromise } from "unthrown";

import {
  QueryFailedError,
  RuntimeClientError,
  ScheduleAlreadyExistsError,
  ScheduleNotFoundError,
  type TemporalFailure,
  UpdateFailedError,
  UpdateRejectedError,
  WorkflowAlreadyStartedError,
  WorkflowCancelledError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
  WorkflowTerminatedError,
  WorkflowTimeoutError,
} from "./errors.js";

/**
 * Translate the contract's typed `searchAttributes` map (declared
 * name → value) into a Temporal `TypedSearchAttributes` instance, so the
 * Temporal client honours indexing when starting the workflow.
 *
 * Workflows without a `searchAttributes` block (or callers passing no
 * values) resolve to `undefined`, matching the Temporal SDK's
 * "absent ≠ empty" semantics.
 *
 * **Throws** a {@link RuntimeClientError} on an undeclared key — a
 * *technical* misconfiguration, not a modeled domain error, so it rides the
 * defect channel (this helper always runs inside a combinator callback or a
 * `makeAsyncResult` work thunk, whose throw→defect net captures it). Value
 * types are the TypeScript surface's job; an undeclared key is checked at
 * runtime because it would otherwise silently drop the attribute, leaving
 * the workflow unindexed without any signal to the caller.
 */
export function toTypedSearchAttributes(
  workflowDef: AnyWorkflowDefinition,
  workflowName: string,
  values: Record<string, unknown> | undefined,
): TypedSearchAttributes | undefined {
  if (!values) return undefined;
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
      // oxlint-disable-next-line unthrown/no-throw -- defect-channel routing: this throw is captured by the enclosing throw→defect net and becomes a defect, never a modeled Err
      throw new RuntimeClientError(
        "searchAttributes",
        new Error(
          `Search attribute "${name}" is not declared on workflow "${workflowName}". ` +
            `Declared attributes: ${Object.keys(declared).join(", ") || "none"}.`,
        ),
      );
    }
    const key = defineSearchAttributeKey(name, def.kind);
    pairs.push({ key, value } as SearchAttributePair);
  }
  return pairs.length > 0 ? new TypedSearchAttributes(pairs) : undefined;
}

// Shared Promise→AsyncResult seam, re-exported from the contract package so
// client and worker wrap their `() => Promise<Result<T, E>>` work functions
// identically. Used by the setup-shaped sites (`TypedClient.create`,
// `schedule.create`) whose multi-step imperative flow doesn't decompose into
// a combinator chain; an unanticipated throw/rejection becomes a defect.
export { _internal_makeAsyncResult as makeAsyncResult } from "@temporal-contract/contract/internal";

/**
 * Run a Standard Schema validation as an `AsyncResult` boundary. The Ok
 * value is the schema's own result object (issues included) — deciding
 * whether issues become a modeled `Err` stays at the call site, which knows
 * the right validation-error class. A schema that *throws* (instead of
 * reporting issues) is a bug in the schema, so it surfaces on the defect
 * channel (`fromSafePromise` — every rejection is a defect).
 */
export function validateStandardSchema(
  schema: StandardSchemaV1,
  value: unknown,
): AsyncResult<StandardSchemaV1.Result<unknown>, never> {
  return fromSafePromise((async () => await schema["~standard"].validate(value))());
}

/**
 * Attempt to rehydrate a workflow failure's cause into a typed
 * {@link ContractError} declared on the workflow's `errors` map. Returns
 * `undefined` when the cause is not an `ApplicationFailure`, or when its
 * `type` / `details` don't match a declared error — callers fall through to
 * the generic {@link WorkflowFailedError} classification.
 */
export async function rehydrateWorkflowContractError(
  workflowDef: AnyWorkflowDefinition,
  cause: unknown,
): Promise<AnyContractError | undefined> {
  if (!(cause instanceof ApplicationFailure)) return undefined;
  return _internal_rehydrateContractError(workflowDef.errors, cause);
}

/**
 * Async tail of the result-error classification: a {@link WorkflowFailedError}
 * whose `cause` matches one of the workflow's declared contract errors
 * rehydrates into that typed error; otherwise the original error flows
 * through unchanged. Composed via `flatMapErrCases` by the two
 * result-awaiting paths (`executeWorkflow` and `handle.result()`) — the
 * rehydration validates the error payload against its declared schema,
 * which may be async, so it can't run inside a synchronous `qualify`.
 */
export function rehydrateFailedResult(
  workflowDef: AnyWorkflowDefinition,
  failed: WorkflowFailedError,
): AsyncResult<never, AnyContractError | WorkflowFailedError> {
  return fromSafePromise(rehydrateWorkflowContractError(workflowDef, failed.cause)).flatMap(
    (rehydrated) => Err(rehydrated ?? failed),
  );
}

/**
 * Recognize a thrown error from `client.workflow.start` / `signalWithStart`
 * as the modeled {@link WorkflowAlreadyStartedError} (Temporal's
 * `WorkflowExecutionAlreadyStartedError`). Returns `undefined` for anything
 * else — an unrecognized, *technical* failure the caller routes to the defect
 * channel with a {@link RuntimeClientError} cause.
 */
export function classifyStartError(error: unknown): WorkflowAlreadyStartedError | undefined {
  if (error instanceof WorkflowExecutionAlreadyStartedError) {
    return new WorkflowAlreadyStartedError(error.workflowType, error.workflowId, error);
  }
  return undefined;
}

/**
 * Recognize a thrown error from a workflow handle method (signal, query,
 * executeUpdate, terminate, cancel, describe, fetchHistory) as the modeled
 * {@link WorkflowExecutionNotFoundError} (Temporal's `WorkflowNotFoundError`).
 * Returns `undefined` for anything else — an unrecognized, *technical* failure
 * the caller routes to the defect channel with a {@link RuntimeClientError}
 * cause.
 *
 * `fallbackWorkflowId` is used when Temporal's error carries an empty
 * `workflowId` (it normalizes missing IDs to the empty string), so the
 * surfaced error always identifies the targeted execution.
 */
export function classifyHandleError(
  error: unknown,
  fallbackWorkflowId: string,
): WorkflowExecutionNotFoundError | undefined {
  if (error instanceof TemporalWorkflowNotFoundError) {
    return new WorkflowExecutionNotFoundError(
      error.workflowId || fallbackWorkflowId,
      error.runId,
      error,
    );
  }
  return undefined;
}

/**
 * Union of the modeled errors {@link classifyResultError} can produce — the
 * result-phase classification of `handle.result()` /
 * `client.workflow.execute()`.
 */
export type ClassifiedResultError =
  | WorkflowFailedError
  | WorkflowCancelledError
  | WorkflowTerminatedError
  | WorkflowTimeoutError
  | WorkflowExecutionNotFoundError;

/**
 * Recognize a thrown error from `handle.result()` / `client.workflow.execute()`
 * (the latter when waiting on the result phase) as one of the modeled
 * result-phase errors. Returns `undefined` for anything else — an
 * unrecognized, *technical* failure the caller routes to the defect channel
 * with a {@link RuntimeClientError} cause.
 *
 * Temporal's `WorkflowFailedError` is itself a wrapper — the actionable
 * failure (ApplicationFailure, CancelledFailure, TerminatedFailure, etc.)
 * lives on its `cause` field. The workflow-outcome causes classify into
 * their own first-class errors so consumers never dig through `cause` with
 * `instanceof`:
 *
 * - `CancelledFailure`  → {@link WorkflowCancelledError}
 * - `TerminatedFailure` → {@link WorkflowTerminatedError}
 * - `TimeoutFailure`    → {@link WorkflowTimeoutError}
 * - anything else       → {@link WorkflowFailedError}
 *
 * In every branch the original inner failure is kept as the surfaced
 * error's `cause` (Temporal's wrapper itself is seen through). If Temporal's
 * cause is `undefined`, the generic {@link WorkflowFailedError} carries an
 * `undefined` cause — same shape as before.
 */
export function classifyResultError(
  error: unknown,
  workflowId: string,
): ClassifiedResultError | undefined {
  if (error instanceof TemporalWorkflowFailedError) {
    const cause = error.cause;
    if (cause instanceof CancelledFailure) {
      return new WorkflowCancelledError(workflowId, cause);
    }
    if (cause instanceof TerminatedFailure) {
      return new WorkflowTerminatedError(workflowId, cause);
    }
    if (cause instanceof TimeoutFailure) {
      return new WorkflowTimeoutError(workflowId, cause);
    }
    // Temporal types `cause` as `Error | undefined`, but the SDK only ever
    // populates it with a `TemporalFailure` subclass when surfacing a
    // workflow result failure. Narrow with the public union so consumers
    // can branch on the leaf failure types without an extra cast.
    return new WorkflowFailedError(workflowId, cause as TemporalFailure | undefined);
  }
  if (error instanceof TemporalWorkflowNotFoundError) {
    return new WorkflowExecutionNotFoundError(error.workflowId || workflowId, error.runId, error);
  }
  return undefined;
}

/**
 * The failure `type` the worker package's update-input validator stamps on
 * the `ApplicationFailure` it throws from Temporal's synchronous validator
 * slot — the wire-level marker of an admission rejection. Kept as a literal
 * (not an import) so the client package doesn't depend on the worker
 * package; the value is pinned by the worker's `UpdateInputValidationError`.
 */
const UPDATE_INPUT_VALIDATION_FAILURE_TYPE = "UpdateInputValidationError";

/**
 * Recognize a thrown error from an update call (`executeUpdate`,
 * `startUpdate`, or the update handle's `result()`) as one of the modeled
 * update errors. Returns `undefined` for anything else — an unrecognized,
 * *technical* failure the caller routes to the defect channel with a
 * {@link RuntimeClientError} cause.
 *
 * Temporal reports both admission rejections and handler failures through
 * the same `WorkflowUpdateFailedError` wrapper; the two are told apart by
 * the failure `type` the `@temporal-contract/worker` validator stamps on a
 * rejection:
 *
 * - cause is the worker's `UpdateInputValidationError` `ApplicationFailure`
 *   → {@link UpdateRejectedError} (the handler never ran);
 * - anything else → {@link UpdateFailedError} (the admitted handler failed).
 *
 * The original inner failure is kept as the surfaced error's `cause`.
 */
export function classifyUpdateError(
  error: unknown,
  updateName: string,
): UpdateFailedError | UpdateRejectedError | undefined {
  if (error instanceof WorkflowUpdateFailedError) {
    const cause = error.cause;
    if (
      cause instanceof ApplicationFailure &&
      cause.type === UPDATE_INPUT_VALIDATION_FAILURE_TYPE
    ) {
      return new UpdateRejectedError(updateName, cause);
    }
    return new UpdateFailedError(updateName, cause);
  }
  return undefined;
}

/**
 * Recognize a thrown error from `handle.query(...)` as the modeled
 * {@link QueryFailedError}. Temporal surfaces both "no handler registered
 * under this name" and "the query handler threw" as
 * `QueryNotRegisteredError` (an `INVALID_ARGUMENT` gRPC failure), so both
 * classify here; the original error is kept as `cause`. Returns `undefined`
 * for anything else — an unrecognized, *technical* failure the caller
 * routes to the defect channel with a {@link RuntimeClientError} cause.
 */
export function classifyQueryError(
  error: unknown,
  queryName: string,
): QueryFailedError | undefined {
  if (error instanceof QueryNotRegisteredError) {
    return new QueryFailedError(queryName, error);
  }
  return undefined;
}

/**
 * Recognize a thrown error from `client.schedule.create` as the modeled
 * {@link ScheduleAlreadyExistsError} (Temporal's `ScheduleAlreadyRunning`).
 * Returns `undefined` for anything else — an unrecognized, *technical*
 * failure the caller routes to the defect channel with a
 * {@link RuntimeClientError} cause. Mirrors {@link classifyStartError} on the
 * workflow side.
 */
export function classifyScheduleCreateError(
  error: unknown,
  fallbackScheduleId: string,
): ScheduleAlreadyExistsError | undefined {
  if (error instanceof ScheduleAlreadyRunning) {
    return new ScheduleAlreadyExistsError(error.scheduleId || fallbackScheduleId, error);
  }
  return undefined;
}

/**
 * Recognize a thrown error from a schedule handle method (pause, unpause,
 * trigger, update, backfill, delete, describe) as the modeled
 * {@link ScheduleNotFoundError} (Temporal's error of the same name). Returns
 * `undefined` for anything else — an unrecognized, *technical* failure the
 * caller routes to the defect channel with a {@link RuntimeClientError}
 * cause. Mirrors {@link classifyHandleError} on the workflow side.
 */
export function classifyScheduleHandleError(
  error: unknown,
  fallbackScheduleId: string,
): ScheduleNotFoundError | undefined {
  if (error instanceof TemporalScheduleNotFoundError) {
    return new ScheduleNotFoundError(error.scheduleId || fallbackScheduleId, error);
  }
  return undefined;
}
