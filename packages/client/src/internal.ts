/**
 * Internal helpers shared across the client package's modules.
 *
 * Not part of the public API — this module is not listed in the package's
 * `exports` map, so consumers can't import from `@temporal-contract/client/internal`.
 * In-package modules and tests import it directly via relative path.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  AnyWorkflowDefinition,
  ContractDefinition,
  SearchAttributeDefinition,
} from "@temporal-contract/contract";
import {
  type AnyContractError,
  type RehydrationMiss,
  TechnicalError,
} from "@temporal-contract/contract/errors";
import { _internal_rehydrateContractError } from "@temporal-contract/contract/internal";
import {
  QueryNotRegisteredError,
  QueryRejectedError,
  ScheduleAlreadyRunning,
  ScheduleNotFoundError as TemporalScheduleNotFoundError,
  WorkflowExecutionAlreadyStartedError,
  WorkflowFailedError as TemporalWorkflowFailedError,
  WorkflowUpdateFailedError,
  WorkflowUpdateRPCTimeoutOrCancelledError,
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
import {
  type AsyncResult,
  Err,
  ErrAsync,
  fromPromise,
  fromSafePromise,
  Ok,
  OkAsync,
} from "unthrown";

import {
  QueryFailedError,
  RuntimeClientError,
  ScheduleAlreadyExistsError,
  ScheduleNotFoundError,
  type TemporalFailure,
  UpdateFailedError,
  UpdateRejectedError,
  UpdateRpcTimeoutOrCancelledError,
  WorkflowAlreadyStartedError,
  WorkflowCancelledError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
  WorkflowTerminatedError,
  WorkflowTimeoutError,
  WorkflowValidationError,
} from "./errors.js";

/** Diagnostic hook for declared contract errors that failed to rehydrate. */
export type OnRehydrationMiss = (miss: RehydrationMiss) => void;

/**
 * Look up a declared contract entry (workflow, signal, update) by name.
 *
 * The typed surface only accepts declared names, so a miss is a caller bug
 * (a cast, a raw call) rather than an anticipated outcome: it **throws** a
 * {@link TechnicalError}, which the enclosing combinator turns into a defect
 * (or, from the synchronous `getHandle` / `getUpdateHandle`, which propagates
 * like any misuse of a synchronous API). `Object.hasOwn`, so a name like
 * `"constructor"` never resolves through the prototype chain.
 */
export function lookupDeclared<T>(
  entries: Record<string, T> | undefined,
  name: string,
  what: "Workflow" | "Signal" | "Update",
  where: string,
): T {
  if (!entries || !Object.hasOwn(entries, name)) {
    // oxlint-disable-next-line unthrown/no-throw -- defect-channel routing: an undeclared name is a caller bug the types already rule out
    throw new TechnicalError(
      `${what} "${name}" is not declared on ${where}. ` +
        `Declared: ${Object.keys(entries ?? {}).join(", ") || "none"}.`,
    );
  }
  return entries[name] as T;
}

/** {@link lookupDeclared} for a workflow on a contract. */
export function lookupWorkflow(
  contract: ContractDefinition,
  workflowName: string,
): AnyWorkflowDefinition {
  return lookupDeclared<AnyWorkflowDefinition>(
    contract.workflows,
    workflowName,
    "Workflow",
    `the contract for task queue "${contract.taskQueue}"`,
  );
}

/**
 * The runtime check behind each declared search-attribute `kind` — the
 * TypeScript surface types the values, this catches what a cast or a raw
 * call lets through before Temporal silently mis-indexes it.
 */
const SEARCH_ATTRIBUTE_KIND_CHECKS: Record<string, (value: unknown) => boolean> = {
  TEXT: (value) => typeof value === "string",
  KEYWORD: (value) => typeof value === "string",
  INT: (value) => Number.isInteger(value),
  DOUBLE: (value) => typeof value === "number",
  BOOL: (value) => typeof value === "boolean",
  DATETIME: (value) => value instanceof Date,
  KEYWORD_LIST: (value) => Array.isArray(value) && value.every((v) => typeof v === "string"),
};

/**
 * Translate the contract's typed `searchAttributes` map (declared
 * name → value) into a Temporal `TypedSearchAttributes` instance, so the
 * Temporal client honours indexing when starting the workflow.
 *
 * Workflows without a `searchAttributes` block (or callers passing no
 * values) resolve to `undefined`, matching the Temporal SDK's
 * "absent ≠ empty" semantics.
 *
 * **Throws** a {@link RuntimeClientError} on an undeclared key or a value
 * that doesn't match its declared kind — a *technical* misconfiguration,
 * not a modeled domain error, so it rides the defect channel (this helper
 * always runs inside a combinator callback, whose throw→defect net captures
 * it). Checked at runtime because either would otherwise silently drop or
 * mis-index the attribute, leaving the workflow unfindable without any
 * signal to the caller.
 */
export function toTypedSearchAttributes(
  workflowDef: AnyWorkflowDefinition,
  workflowName: string,
  values: Record<string, unknown> | undefined,
): TypedSearchAttributes | undefined {
  if (!values) return undefined;
  // Workflows that omit the `searchAttributes` block declare none. Treat
  // that as an empty declared map so a caller passing values still hits
  // the per-key "undeclared" check below.
  const declared = (workflowDef.searchAttributes ?? {}) as Record<
    string,
    SearchAttributeDefinition
  >;
  const pairs: SearchAttributePair[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const def = Object.hasOwn(declared, name) ? declared[name] : undefined;
    if (!def) {
      // oxlint-disable-next-line unthrown/no-throw -- defect-channel routing: this throw is captured by the enclosing throw→defect net and becomes a defect, never a modeled Err
      throw searchAttributeError(
        `Search attribute "${name}" is not declared on workflow "${workflowName}". ` +
          `Declared attributes: ${Object.keys(declared).join(", ") || "none"}.`,
      );
    }
    if (!SEARCH_ATTRIBUTE_KIND_CHECKS[def.kind]?.(value)) {
      // oxlint-disable-next-line unthrown/no-throw -- defect-channel routing: as above
      throw searchAttributeError(
        `Search attribute "${name}" on workflow "${workflowName}" is declared ${def.kind}, ` +
          `but got ${Array.isArray(value) ? "an array" : `${typeof value} ${String(value)}`}.`,
      );
    }
    pairs.push({ key: defineSearchAttributeKey(name, def.kind), value } as SearchAttributePair);
  }
  return pairs.length > 0 ? new TypedSearchAttributes(pairs) : undefined;
}

function searchAttributeError(message: string): RuntimeClientError {
  return new RuntimeClientError("searchAttributes", new Error(message));
}

// Shared Promise→AsyncResult seam, re-exported from the contract package so
// client and worker wrap their `() => Promise<Result<T, E>>` work functions
// identically. Used by `TypedClient.create`, whose imperative setup flow
// doesn't decompose into a combinator chain; an unanticipated
// throw/rejection becomes a defect.
export { _internal_makeAsyncResult as makeAsyncResult } from "@temporal-contract/contract/internal";

/**
 * Wrap one Temporal call: a rejection the call site's `classify` recognizes
 * becomes that modeled Err; anything else is an unrecognized, *technical*
 * failure routed to the defect channel with a {@link RuntimeClientError}
 * naming `operation`.
 */
export function call<T, E>(
  operation: string,
  promise: Promise<T>,
  classify: (error: unknown) => E | undefined,
): AsyncResult<T, E> {
  // `fromPromise` types its error as `Exclude<R, Defect>` behind a
  // "qualify must be synchronous" guard, neither of which TypeScript can
  // resolve for a generic `E`; typing the qualifier `never` sidesteps both,
  // and the declared return type restores `E`.
  return fromPromise<T, never>(
    promise,
    (error, defect) =>
      (classify(error) ?? defect(new RuntimeClientError(operation, error))) as never,
  );
}

/**
 * Parse a value against a Standard Schema as an `AsyncResult`: the parsed
 * value on success, `onIssues(issues)` as the modeled Err otherwise. A
 * schema that *throws* (instead of reporting issues) is a bug in the
 * schema, so it surfaces on the defect channel.
 */
export function parseWithSchema<E>(
  schema: StandardSchemaV1,
  value: unknown,
  onIssues: (issues: ReadonlyArray<StandardSchemaV1.Issue>) => E,
): AsyncResult<unknown, E> {
  return fromSafePromise((async () => await schema["~standard"].validate(value))()).flatMap(
    (result) => (result.issues ? Err(onIssues(result.issues)) : Ok(result.value)),
  );
}

/** What {@link validateWorkflowInput} resolves for a start-shaped call. */
type ValidatedWorkflowInput = {
  definition: AnyWorkflowDefinition;
  /**
   * The input as the schema produced it. The caller's ORIGINAL value still
   * crosses the wire (the worker parses on receive); this is here so a
   * contract-declared `workflowId` derivation runs against the
   * post-transform value. Deriving from the raw payload would give
   * `"  ORD-1  "` and `"ORD-1"` two different workflow IDs, which is exactly
   * the collision the derivation exists to force.
   */
  validatedInput: unknown;
  typedSearchAttributes: TypedSearchAttributes | undefined;
};

/**
 * The shared pre-call ritual of every entry point that starts (or derives
 * the ID of) a workflow — `startWorkflow`, `signalWithStart`,
 * `executeUpdateWithStart`, `workflowIdFor`, `schedule.create`:
 *
 *   1. Look up the workflow definition (an undeclared name is a defect).
 *   2. Validate `args` against the input schema — `WorkflowValidationError`.
 *   3. Translate `searchAttributes` into Temporal's `TypedSearchAttributes`
 *      (an undeclared key or mismatched kind is a defect).
 *
 * The parsed input is only used to derive a workflow ID: the caller
 * transmits the original `args` and the worker parses them on receive, so a
 * transforming schema applies exactly once per boundary.
 */
export function validateWorkflowInput(
  contract: ContractDefinition,
  workflowName: string,
  args: unknown,
  searchAttributes: Record<string, unknown> | undefined,
  workflowId?: string,
): AsyncResult<ValidatedWorkflowInput, WorkflowValidationError> {
  // Starting from `OkAsync()` puts the lookup's misuse throw inside the
  // combinator's throw→defect net instead of letting it escape the call.
  return OkAsync().flatMap(() => {
    const definition = lookupWorkflow(contract, workflowName);
    return parseWithSchema(
      definition.input,
      args,
      (issues) => new WorkflowValidationError(workflowName, "input", issues, workflowId),
    ).map((validatedInput) => ({
      definition,
      validatedInput,
      typedSearchAttributes: toTypedSearchAttributes(definition, workflowName, searchAttributes),
    }));
  });
}

/**
 * The contract's workflow-ID derivation applied to the validated input, or
 * `undefined` when the workflow declares none (the caller supplies the ID).
 */
export function deriveWorkflowId(
  definition: AnyWorkflowDefinition,
  validatedInput: unknown,
): string | undefined {
  // The structural slot types its parameter `never` so plain-object contracts
  // stay assignable (see `WorkflowDefinition`); the value passed here is the
  // validated input the derivation was written against.
  const derive = definition.workflowId as ((input: unknown) => string) | undefined;
  return derive?.(validatedInput);
}

/**
 * Async tail of the result-error classification: a {@link WorkflowFailedError}
 * whose `cause` is an `ApplicationFailure` matching one of the workflow's
 * declared contract errors rehydrates into that typed error; otherwise the
 * original error flows through unchanged. Composed via `flatMapErrCases` by
 * `handle.result()` — the rehydration validates the error payload against
 * its declared schema, which may be async, so it can't run inside a
 * synchronous `qualify`.
 */
export function rehydrateFailedResult(
  workflowDef: AnyWorkflowDefinition,
  failed: WorkflowFailedError,
  onMiss: OnRehydrationMiss | undefined,
): AsyncResult<never, AnyContractError | WorkflowFailedError> {
  const cause = failed.cause;
  if (!(cause instanceof ApplicationFailure)) return ErrAsync(failed);
  return fromSafePromise(
    _internal_rehydrateContractError(workflowDef.errors, cause, onMiss ? { onMiss } : undefined),
  ).flatMap((rehydrated) => Err(rehydrated ?? failed));
}

/**
 * Recognize a thrown error from a start-shaped call as the modeled
 * {@link WorkflowAlreadyStartedError} (Temporal's
 * `WorkflowExecutionAlreadyStartedError`).
 */
export function classifyStartError(error: unknown): WorkflowAlreadyStartedError | undefined {
  if (error instanceof WorkflowExecutionAlreadyStartedError) {
    return new WorkflowAlreadyStartedError(error.workflowType, error.workflowId, error);
  }
  return undefined;
}

/**
 * Recognize a thrown error from a workflow handle method as the modeled
 * {@link WorkflowExecutionNotFoundError} (Temporal's `WorkflowNotFoundError`).
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
 * result-phase classification of `handle.result()`.
 */
type ClassifiedResultError =
  | WorkflowFailedError
  | WorkflowCancelledError
  | WorkflowTerminatedError
  | WorkflowTimeoutError
  | WorkflowExecutionNotFoundError;

/**
 * Recognize a thrown error from `handle.result()` as one of the modeled
 * result-phase errors.
 *
 * Temporal's `WorkflowFailedError` is itself a wrapper — the actionable
 * failure lives on its `cause` field. The workflow-outcome causes classify
 * into their own first-class errors so consumers never dig through `cause`
 * with `instanceof`:
 *
 * - `CancelledFailure`  → {@link WorkflowCancelledError}
 * - `TerminatedFailure` → {@link WorkflowTerminatedError}
 * - `TimeoutFailure`    → {@link WorkflowTimeoutError}
 * - anything else       → {@link WorkflowFailedError} (with `retryState`)
 *
 * In every branch the original inner failure is kept as the surfaced
 * error's `cause` (Temporal's wrapper itself is seen through).
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
    return new WorkflowFailedError(
      workflowId,
      cause as TemporalFailure | undefined,
      error.retryState,
    );
  }
  return classifyHandleError(error, workflowId);
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
 * Recognize a thrown *update RPC* failure: Temporal's
 * `WorkflowUpdateRPCTimeoutOrCancelledError`, raised by every update call
 * (start, execute, poll for the outcome) when the call itself timed out or
 * was cancelled.
 */
export function classifyUpdateRpcError(
  error: unknown,
  updateName: string,
): UpdateRpcTimeoutOrCancelledError | undefined {
  if (error instanceof WorkflowUpdateRPCTimeoutOrCancelledError) {
    return new UpdateRpcTimeoutOrCancelledError(updateName, error);
  }
  return undefined;
}

/**
 * Recognize a thrown *update outcome* — raised by `executeUpdate`, an update
 * handle's `result()`, and `executeUpdateWithStart`, never by `startUpdate`
 * (SDK 1.24 hands back the handle and defers the outcome to `result()`).
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
 * A timed-out/cancelled call is classified too (see
 * {@link classifyUpdateRpcError}). The original inner failure is kept as the
 * surfaced error's `cause`.
 */
export function classifyUpdateError(
  error: unknown,
  updateName: string,
): UpdateFailedError | UpdateRejectedError | UpdateRpcTimeoutOrCancelledError | undefined {
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
  return classifyUpdateRpcError(error, updateName);
}

/**
 * Recognize a thrown error from `handle.query(...)` as the modeled
 * {@link QueryFailedError}: Temporal's `QueryNotRegisteredError` (no handler,
 * or the handler threw) and `QueryRejectedError` (the client's
 * `queryRejectCondition` matched the execution's status).
 */
export function classifyQueryError(
  error: unknown,
  queryName: string,
): QueryFailedError | undefined {
  if (error instanceof QueryNotRegisteredError || error instanceof QueryRejectedError) {
    return new QueryFailedError(queryName, error);
  }
  return undefined;
}

/**
 * Recognize a thrown error from `client.schedule.create` as the modeled
 * {@link ScheduleAlreadyExistsError} (Temporal's `ScheduleAlreadyRunning`).
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
 * Recognize a thrown error from a schedule handle method as the modeled
 * {@link ScheduleNotFoundError} (Temporal's error of the same name).
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
