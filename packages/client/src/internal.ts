/**
 * Internal helpers shared across the client package's modules.
 *
 * Not part of the public API — this module is not listed in the package's
 * `exports` map, so consumers can't import from `@temporal-contract/client/internal`.
 * In-package modules and tests import it directly via relative path.
 */
import type {
  AnyWorkflowDefinition,
  SearchAttributeDefinition,
  SearchAttributeKind,
} from "@temporal-contract/contract";
import {
  _internal_rehydrateContractError,
  type AnyContractError,
} from "@temporal-contract/contract/errors";
import { _internal_makeAsyncResult } from "@temporal-contract/contract/result-async";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { WorkflowFailedError as TemporalWorkflowFailedError } from "@temporalio/client";
import {
  ScheduleAlreadyRunning,
  ScheduleNotFoundError as TemporalScheduleNotFoundError,
} from "@temporalio/client";
import {
  ApplicationFailure,
  defineSearchAttributeKey,
  type SearchAttributePair,
  TypedSearchAttributes,
  WorkflowNotFoundError as TemporalWorkflowNotFoundError,
} from "@temporalio/common";
import { type AsyncResult, type Result } from "unthrown";

// `assertNoDefect` narrows an internally-built `Result` (known to carry only
// ok/err) to `Ok | Err`, re-throwing a stray defect's cause — so call sites
// reach `.value` / `.error` without a manual "impossible defect" guard.
export { _internal_assertNoDefect as assertNoDefect } from "@temporal-contract/contract/result-async";
import {
  RuntimeClientError,
  ScheduleAlreadyExistsError,
  ScheduleNotFoundError,
  type TemporalFailure,
  WorkflowAlreadyStartedError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
} from "./errors.js";

/**
 * Runtime `typeof`-per-kind check for a search attribute value. The
 * TypeScript surface already constrains values on the happy path; this
 * catches typed escape hatches (`as never`, raw-call interop) where a
 * mistyped value would otherwise be rejected server-side (or silently
 * coerced) long after the call site.
 */
const searchAttributeValueChecks: Record<
  SearchAttributeKind,
  { expected: string; check: (value: unknown) => boolean }
> = {
  TEXT: { expected: "a string", check: (v) => typeof v === "string" },
  KEYWORD: { expected: "a string", check: (v) => typeof v === "string" },
  INT: {
    expected: "an integer number",
    check: (v) => typeof v === "number" && Number.isInteger(v),
  },
  DOUBLE: { expected: "a number", check: (v) => typeof v === "number" && Number.isFinite(v) },
  BOOL: { expected: "a boolean", check: (v) => typeof v === "boolean" },
  DATETIME: { expected: "a Date", check: (v) => v instanceof Date },
  KEYWORD_LIST: {
    expected: "an array of strings",
    check: (v) => Array.isArray(v) && v.every((entry) => typeof entry === "string"),
  },
};

/**
 * Name a value's runtime type for error messages. `typeof` alone reports
 * `"object"` for arrays, `Date`s, and `null` — the three shapes search
 * attributes actually trip over — so spell those out.
 */
function describeRuntimeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (value instanceof Date) return "a Date";
  return `a ${typeof value}`;
}

/**
 * Translate the contract's typed `searchAttributes` map (declared
 * name → value) into a Temporal `TypedSearchAttributes` instance, so the
 * Temporal client honours indexing when starting the workflow.
 *
 * Workflows without a `searchAttributes` block (or callers passing no
 * values) resolve to `undefined`, matching the Temporal SDK's
 * "absent ≠ empty" semantics.
 *
 * **Throws** a {@link RuntimeClientError} on unknown keys or on values that
 * don't match the declared kind's runtime type — a *technical*
 * misconfiguration, not a modeled domain error, so it rides the defect
 * channel (this helper always runs inside a `makeAsyncResult` work thunk,
 * whose throw→defect net captures it). The TypeScript surface already gates
 * the happy path; the runtime check catches typed escape hatches (`as never`,
 * `as any`, raw-call interop) where a typo would otherwise silently drop the
 * attribute, leaving the workflow unindexed without any signal to the caller.
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
      throw new RuntimeClientError(
        "searchAttributes",
        new Error(
          `Search attribute "${name}" is not declared on workflow "${workflowName}". ` +
            `Declared attributes: ${Object.keys(declared).join(", ") || "none"}.`,
        ),
      );
    }
    const { expected, check } = searchAttributeValueChecks[def.kind];
    if (!check(value)) {
      throw new RuntimeClientError(
        "searchAttributes",
        new Error(
          `Search attribute "${name}" on workflow "${workflowName}" is declared as ` +
            `${def.kind} and must be ${expected}; received ${describeRuntimeType(value)}.`,
        ),
      );
    }
    const key = defineSearchAttributeKey(name, def.kind);
    pairs.push({ key, value } as SearchAttributePair);
  }
  return pairs.length > 0 ? new TypedSearchAttributes(pairs) : undefined;
}

/**
 * Wrap an async result-producing function in an `AsyncResult`, routing any
 * unanticipated rejection through unthrown's `defect` channel.
 *
 * The work function is expected to handle its own domain errors and return
 * an `Err(...)` for them; a thrown exception the work didn't anticipate is an
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
// oxlint-disable-next-line unthrown/prefer-async-result -- this IS the Promise→AsyncResult conversion seam: the work thunk's throw/rejection is what becomes the defect, and an async implementer cannot be annotated AsyncResult
export function makeAsyncResult<T, E>(work: () => Promise<Result<T, E>>): AsyncResult<T, E> {
  return _internal_makeAsyncResult(work);
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
 * Recognize a thrown error from `handle.result()` / `client.workflow.execute()`
 * (the latter when waiting on the result phase) as one of the modeled
 * {@link WorkflowFailedError} / {@link WorkflowExecutionNotFoundError}
 * (Temporal's `WorkflowFailedError` / `WorkflowNotFoundError`). Returns
 * `undefined` for anything else — an unrecognized, *technical* failure the
 * caller routes to the defect channel with a {@link RuntimeClientError} cause.
 *
 * Temporal's `WorkflowFailedError` is itself a wrapper — the actionable
 * failure (ApplicationFailure, CancelledFailure, TerminatedFailure, etc.)
 * lives on its `cause` field. We forward that inner cause directly so
 * consumers can match `err.cause` against the underlying failure class
 * without an extra unwrap step. (If Temporal's cause is `undefined`, our
 * `cause` is too — same shape as before.)
 */
export function classifyResultError(
  error: unknown,
  workflowId: string,
): WorkflowFailedError | WorkflowExecutionNotFoundError | undefined {
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
  return undefined;
}

/**
 * Shared rehydrate-then-classify tail for the two result-awaiting paths
 * (`executeWorkflow` and `handle.result()`): a Temporal `WorkflowFailedError`
 * whose cause matches one of the workflow's declared contract errors
 * rehydrates into that typed error; everything else falls through to
 * {@link classifyResultError}. Returns `undefined` for unrecognized errors —
 * the caller routes those to the defect channel.
 */
export async function classifyExecutionResultError(
  workflowDef: AnyWorkflowDefinition,
  error: unknown,
  workflowId: string,
): Promise<AnyContractError | WorkflowFailedError | WorkflowExecutionNotFoundError | undefined> {
  if (error instanceof TemporalWorkflowFailedError) {
    const rehydrated = await rehydrateWorkflowContractError(workflowDef, error.cause);
    if (rehydrated) return rehydrated;
  }
  return classifyResultError(error, workflowId);
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
