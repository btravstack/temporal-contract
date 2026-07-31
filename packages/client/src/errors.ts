import type { StandardSchemaV1 } from "@standard-schema/spec";
import { summarizeIssues } from "@temporal-contract/contract";
import type {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  ChildWorkflowFailure,
  ServerFailure,
  TerminatedFailure,
  TimeoutFailure,
} from "@temporalio/common";
import { P, TaggedError } from "unthrown";

import {
  QUERY_FAILED_ERROR_TAG,
  QUERY_VALIDATION_ERROR_TAG,
  RUNTIME_CLIENT_ERROR_TAG,
  SCHEDULE_ALREADY_EXISTS_ERROR_TAG,
  SCHEDULE_NOT_FOUND_ERROR_TAG,
  SIGNAL_VALIDATION_ERROR_TAG,
  UPDATE_FAILED_ERROR_TAG,
  UPDATE_REJECTED_ERROR_TAG,
  UPDATE_VALIDATION_ERROR_TAG,
  WORKFLOW_ALREADY_STARTED_ERROR_TAG,
  WORKFLOW_CANCELLED_ERROR_TAG,
  WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG,
  WORKFLOW_FAILED_ERROR_TAG,
  WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG,
  WORKFLOW_TERMINATED_ERROR_TAG,
  WORKFLOW_TIMEOUT_ERROR_TAG,
  WORKFLOW_VALIDATION_ERROR_TAG,
} from "./error-tags.js";

/**
 * Union of the actionable Temporal failure types that can surface as the
 * `cause` of a `WorkflowFailedError`. These all extend Temporal's internal
 * `TemporalFailure` base class — we list them by leaf type rather than by
 * the base class so consumer code can use a single `switch (true)` over
 * `instanceof` discriminants without an exhaustiveness escape hatch.
 *
 * Note that the cancellation/termination/timeout members are classified into
 * their own first-class errors ({@link WorkflowCancelledError},
 * {@link WorkflowTerminatedError}, {@link WorkflowTimeoutError}) before a
 * generic `WorkflowFailedError` is ever surfaced, so in practice a
 * `WorkflowFailedError.cause` carries one of the remaining members.
 *
 * Re-exported from the package entry point so consumers can import it
 * directly: `import type { TemporalFailure } from "@temporal-contract/client"`.
 */
export type TemporalFailure =
  | ApplicationFailure
  | CancelledFailure
  | TerminatedFailure
  | TimeoutFailure
  | ChildWorkflowFailure
  | ServerFailure
  | ActivityFailure;

/**
 * The `{ _tag: … }` object patterns for a tuple of tag literals, in tuple
 * order — the type produced by {@link tagPatterns}.
 */
export type TagPatterns<TTags extends readonly string[]> = {
  [K in keyof TTags]: { _tag: TTags[K] };
};

/**
 * Map a tag bundle (an `as const` tuple of `_tag` literals — see
 * `error-tags.ts`) to a tuple of `P.tag` patterns, so the bundle can be
 * spread into a grouped matcher arm:
 *
 * ```ts
 * import { tagPatterns, WORKFLOW_RESULT_ERROR_TAGS } from "@temporal-contract/client";
 *
 * result.match({
 *   ok: (output) => ...,
 *   errCases: (matcher) =>
 *     matcher.with(...tagPatterns(WORKFLOW_RESULT_ERROR_TAGS), (error) => ...),
 *   defect: (cause) => ...,
 * });
 * ```
 *
 * The tuple shape is preserved (`TagPatterns<TTags>`), which is what makes
 * the spread compile — a plain `tags.map(P.tag)` loses tuple-ness and can't
 * be spread into the matcher's variadic `with(...)`.
 */
export function tagPatterns<const TTags extends readonly string[]>(
  tags: TTags,
): TagPatterns<TTags> {
  return tags.map((tag) => P.tag(tag)) as TagPatterns<TTags>;
}

/**
 * Generic runtime failure wrapper when no specific error type applies
 */
export class RuntimeClientError extends TaggedError(RUNTIME_CLIENT_ERROR_TAG, {
  name: "RuntimeClientError",
})<{
  operation: string;
  cause?: unknown;
}> {
  constructor(operation: string, cause?: unknown) {
    super({ operation, cause });
    this.message = `Operation "${operation}" failed: ${
      cause instanceof Error ? cause.message : String(cause ?? "unknown error")
    }`;
  }
}

/**
 * Surfaced on the Err channel when a workflow name is not declared in the
 * bound contract. This is a contract-level lookup failure (a typo, a stale
 * contract) — distinct from Temporal's own `WorkflowNotFoundError`, which is
 * about a missing *execution* and surfaces here as
 * {@link WorkflowExecutionNotFoundError}.
 */
export class WorkflowNotInContractError extends TaggedError(WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG, {
  name: "WorkflowNotInContractError",
})<{
  workflowName: string;
  availableWorkflows: readonly string[];
}> {
  constructor(workflowName: string, availableWorkflows: readonly string[]) {
    super({ workflowName, availableWorkflows });
    this.message = `Workflow "${workflowName}" not found in contract. Available workflows: ${availableWorkflows.join(", ")}`;
  }
}

/**
 * Discriminated variant of {@link RuntimeClientError} surfaced when starting
 * a workflow collides with an existing execution — Temporal's
 * `WorkflowExecutionAlreadyStartedError`. The most common cause is a
 * workflowId reuse policy that rejects duplicates while a previous run is
 * still in retention.
 *
 * Distinguishing this from `RuntimeClientError` lets idempotent callers
 * branch on it explicitly (e.g. fetch the existing handle and continue)
 * without inspecting `error.cause` against a Temporal SDK class.
 */
export class WorkflowAlreadyStartedError extends TaggedError(WORKFLOW_ALREADY_STARTED_ERROR_TAG, {
  name: "WorkflowAlreadyStartedError",
})<{
  workflowType: string;
  workflowId: string;
  cause?: unknown;
}> {
  constructor(workflowType: string, workflowId: string, cause?: unknown) {
    super({ workflowType, workflowId, cause });
    this.message = `Workflow "${workflowType}" with ID "${workflowId}" is already started or in retention.`;
  }
}

/**
 * Discriminated variant of {@link RuntimeClientError} surfaced when an
 * operation targets a workflow execution that doesn't exist in the
 * namespace — Temporal's `WorkflowNotFoundError` (distinct from this
 * package's contract-level {@link WorkflowNotInContractError}).
 *
 * Returned from:
 * - handle methods: `signal`, `query`, `executeUpdate`, `result`,
 *   `terminate`, `cancel`, `describe`, `fetchHistory`
 * - `executeWorkflow` (when the underlying execute call hits a missing
 *   execution mid-flight)
 */
export class WorkflowExecutionNotFoundError extends TaggedError(
  WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG,
  { name: "WorkflowExecutionNotFoundError" },
)<{
  workflowId: string;
  runId?: string | undefined;
  cause?: unknown;
}> {
  constructor(workflowId: string, runId?: string, cause?: unknown) {
    super({ workflowId, runId, cause });
    this.message = `Workflow execution "${workflowId}"${runId ? ` (run "${runId}")` : ""} not found in namespace.`;
  }
}

/**
 * Discriminated variant of {@link RuntimeClientError} surfaced when waiting
 * on a workflow's result and the workflow completes with a failure —
 * Temporal's `WorkflowFailedError`.
 *
 * `cause` is the *unwrapped* underlying {@link TemporalFailure} (typically an
 * `ApplicationFailure`) lifted from Temporal's wrapper, so callers can branch
 * on the failure category in one step (`err.cause instanceof
 * ApplicationFailure`) instead of unwrapping twice via the SDK wrapper. The
 * SDK declares `WorkflowFailedError.cause` as the wider `Error | undefined`
 * (since `cause` lives on `Error`), but the runtime guarantee — driven by
 * Temporal's wire format — is that it is always a `TemporalFailure` subclass
 * when the wrapper is surfaced. `classifyResultError` narrows that wider
 * static type to the public {@link TemporalFailure} union with a cast, so
 * consumers see the precise leaf-failure typing instead of a bare `Error`.
 *
 * Cancellation, termination, and timeout outcomes do NOT surface here: they
 * are classified into the first-class {@link WorkflowCancelledError},
 * {@link WorkflowTerminatedError}, and {@link WorkflowTimeoutError} before
 * this generic wrapper is considered, so `instanceof` digging through
 * `cause` is never needed to tell them apart.
 *
 * Returned from `executeWorkflow` and `handle.result()`.
 */
export class WorkflowFailedError extends TaggedError(WORKFLOW_FAILED_ERROR_TAG, {
  name: "WorkflowFailedError",
})<{
  workflowId: string;
  cause?: TemporalFailure | undefined;
}> {
  constructor(workflowId: string, cause?: TemporalFailure) {
    const causeMessage =
      cause instanceof Error ? cause.message : String(cause ?? "unknown failure");
    super({ workflowId, cause });
    this.message = `Workflow "${workflowId}" completed with failure: ${causeMessage}`;
  }
}

/**
 * Surfaced on the Err channel when the awaited workflow execution ended
 * `Cancelled` — Temporal's `WorkflowFailedError` wrapping a
 * `CancelledFailure`. `cause` keeps the original {@link CancelledFailure}.
 *
 * **Swallowing this error hides the cancellation.** Cancellation rides the
 * modeled `Err(...)` channel here (mirroring the worker package's
 * cancellation errors), so generic error handling that maps every `Err` to a
 * blanket "failed" outcome silently conflates "the workflow was cancelled on
 * purpose" with "the workflow broke". Give cancellation its own matcher arm
 * when the two must diverge.
 *
 * Returned from `executeWorkflow` and `handle.result()`.
 */
export class WorkflowCancelledError extends TaggedError(WORKFLOW_CANCELLED_ERROR_TAG, {
  name: "WorkflowCancelledError",
})<{
  workflowId: string;
  cause?: CancelledFailure | undefined;
}> {
  constructor(workflowId: string, cause?: CancelledFailure) {
    super({ workflowId, cause });
    this.message = `Workflow "${workflowId}" was cancelled.`;
  }
}

/**
 * Surfaced on the Err channel when the awaited workflow execution was
 * terminated — Temporal's `WorkflowFailedError` wrapping a
 * `TerminatedFailure`. `cause` keeps the original {@link TerminatedFailure}
 * (whose `message` carries the terminate reason, when one was given).
 *
 * Returned from `executeWorkflow` and `handle.result()`.
 */
export class WorkflowTerminatedError extends TaggedError(WORKFLOW_TERMINATED_ERROR_TAG, {
  name: "WorkflowTerminatedError",
})<{
  workflowId: string;
  cause?: TerminatedFailure | undefined;
}> {
  constructor(workflowId: string, cause?: TerminatedFailure) {
    super({ workflowId, cause });
    this.message = `Workflow "${workflowId}" was terminated${
      cause?.message ? `: ${cause.message}` : "."
    }`;
  }
}

/**
 * Surfaced on the Err channel when the awaited workflow execution timed
 * out — Temporal's `WorkflowFailedError` wrapping a `TimeoutFailure`.
 * `cause` keeps the original {@link TimeoutFailure} (whose `timeoutType`
 * names which timeout fired).
 *
 * Returned from `executeWorkflow` and `handle.result()`.
 */
export class WorkflowTimeoutError extends TaggedError(WORKFLOW_TIMEOUT_ERROR_TAG, {
  name: "WorkflowTimeoutError",
})<{
  workflowId: string;
  cause?: TimeoutFailure | undefined;
}> {
  constructor(workflowId: string, cause?: TimeoutFailure) {
    super({ workflowId, cause });
    this.message = `Workflow "${workflowId}" timed out.`;
  }
}

// Validation-message formatters live in `@temporal-contract/contract` so
// client and worker share a single source of truth. The previous local
// copies have been removed in favor of the shared `summarizeIssues` import
// at the top of this module.

/**
 * Surfaced on the Err channel when workflow input or output validation fails.
 *
 * `workflowId` identifies the targeted execution when the failing call knows
 * it (start/execute/signalWithStart options, a handle's bound execution);
 * it is absent for call sites without one (e.g. `schedule.create`, where
 * runs are spawned later).
 */
export class WorkflowValidationError extends TaggedError(WORKFLOW_VALIDATION_ERROR_TAG, {
  name: "WorkflowValidationError",
})<{
  workflowName: string;
  direction: "input" | "output";
  issues: ReadonlyArray<StandardSchemaV1.Issue>;
  workflowId?: string | undefined;
}> {
  constructor(
    workflowName: string,
    direction: "input" | "output",
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
    workflowId?: string,
  ) {
    super({ workflowName, direction, issues, workflowId });
    this.message = `Validation failed for workflow "${workflowName}" ${direction}: ${summarizeIssues(issues)}`;
  }
}

/**
 * Surfaced on the Err channel when query input or output validation fails
 */
export class QueryValidationError extends TaggedError(QUERY_VALIDATION_ERROR_TAG, {
  name: "QueryValidationError",
})<{
  queryName: string;
  direction: "input" | "output";
  issues: ReadonlyArray<StandardSchemaV1.Issue>;
}> {
  constructor(
    queryName: string,
    direction: "input" | "output",
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    super({ queryName, direction, issues });
    this.message = `Validation failed for query "${queryName}" ${direction}: ${summarizeIssues(issues)}`;
  }
}

/**
 * Surfaced on the Err channel when the server could not serve a query —
 * either no handler is registered under the query name on the (possibly
 * older) workflow execution, or the query handler itself threw. Temporal
 * reports both through the same channel (`QueryNotRegisteredError`, an
 * `INVALID_ARGUMENT` gRPC failure whose message carries the underlying
 * reason), so they are classified into this single modeled error; `cause`
 * keeps Temporal's original error for inspection.
 *
 * A routine operational outcome — a stale execution predating the handler,
 * a handler bug — not a technical fault, so it rides the Err channel
 * instead of the defect channel.
 *
 * Returned from the typed handle's `queries.*` proxies.
 */
export class QueryFailedError extends TaggedError(QUERY_FAILED_ERROR_TAG, {
  name: "QueryFailedError",
})<{
  queryName: string;
  cause?: unknown;
}> {
  constructor(queryName: string, cause?: unknown) {
    super({ queryName, cause });
    this.message = `Query "${queryName}" failed: ${
      cause instanceof Error ? cause.message : String(cause ?? "unknown error")
    }`;
  }
}

/**
 * Surfaced on the Err channel when signal input validation fails
 */
export class SignalValidationError extends TaggedError(SIGNAL_VALIDATION_ERROR_TAG, {
  name: "SignalValidationError",
})<{
  signalName: string;
  issues: ReadonlyArray<StandardSchemaV1.Issue>;
}> {
  constructor(signalName: string, issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super({ signalName, issues });
    this.message = `Validation failed for signal "${signalName}": ${summarizeIssues(issues)}`;
  }
}

/**
 * Surfaced on the Err channel when update input or output validation fails
 */
export class UpdateValidationError extends TaggedError(UPDATE_VALIDATION_ERROR_TAG, {
  name: "UpdateValidationError",
})<{
  updateName: string;
  direction: "input" | "output";
  issues: ReadonlyArray<StandardSchemaV1.Issue>;
}> {
  constructor(
    updateName: string,
    direction: "input" | "output",
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    super({ updateName, direction, issues });
    this.message = `Validation failed for update "${updateName}" ${direction}: ${summarizeIssues(issues)}`;
  }
}

/**
 * Surfaced on the Err channel when an admitted update's handler failed —
 * Temporal's `WorkflowUpdateFailedError`, minus the admission rejections
 * classified as {@link UpdateRejectedError}. A routine business failure of
 * the update itself (the handler threw an `ApplicationFailure`), not a
 * technical fault, so it rides the Err channel instead of the defect
 * channel.
 *
 * `cause` is the *unwrapped* underlying failure (typically an
 * `ApplicationFailure`) lifted from Temporal's wrapper, mirroring
 * {@link WorkflowFailedError.cause}.
 *
 * Returned from the typed handle's `updates.*` proxies, `startUpdate`, and
 * the update handle's `result()`.
 */
export class UpdateFailedError extends TaggedError(UPDATE_FAILED_ERROR_TAG, {
  name: "UpdateFailedError",
})<{
  updateName: string;
  cause?: unknown;
}> {
  constructor(updateName: string, cause?: unknown) {
    super({ updateName, cause });
    this.message = `Update "${updateName}" failed: ${
      cause instanceof Error ? cause.message : String(cause ?? "unknown error")
    }`;
  }
}

/**
 * Surfaced on the Err channel when an update was rejected at admission by
 * the worker-side input validator — the update handler never ran. With a
 * `@temporal-contract/worker` on the other side of the task queue, this is
 * the update-input schema rejecting the payload (the worker's
 * `UpdateInputValidationError`, whose message summarizes the failing
 * fields); `cause` keeps that original `ApplicationFailure`.
 *
 * Distinct from {@link UpdateValidationError} (the *client-side* schema
 * check, which fails before anything is sent) and from
 * {@link UpdateFailedError} (the handler was admitted and then failed).
 *
 * Returned from the typed handle's `updates.*` proxies, `startUpdate`, and
 * the update handle's `result()`.
 */
export class UpdateRejectedError extends TaggedError(UPDATE_REJECTED_ERROR_TAG, {
  name: "UpdateRejectedError",
})<{
  updateName: string;
  cause?: unknown;
}> {
  constructor(updateName: string, cause?: unknown) {
    super({ updateName, cause });
    this.message = `Update "${updateName}" was rejected at admission: ${
      cause instanceof Error ? cause.message : String(cause ?? "unknown error")
    }`;
  }
}

/**
 * Surfaced on the Err channel when `schedule.create` collides with a
 * running (not deleted) schedule bearing the same `scheduleId` — Temporal's
 * `ScheduleAlreadyRunning`. Idempotent callers can branch on it explicitly
 * (e.g. fetch the existing handle and continue).
 */
export class ScheduleAlreadyExistsError extends TaggedError(SCHEDULE_ALREADY_EXISTS_ERROR_TAG, {
  name: "ScheduleAlreadyExistsError",
})<{
  scheduleId: string;
  cause?: unknown;
}> {
  constructor(scheduleId: string, cause?: unknown) {
    super({ scheduleId, cause });
    this.message = `Schedule "${scheduleId}" already exists (running, not deleted).`;
  }
}

/**
 * Surfaced on the Err channel when a schedule-handle operation targets a
 * schedule ID unknown to the Temporal server — Temporal's
 * `ScheduleNotFoundError`. Either the ID is wrong or the schedule was
 * deleted.
 */
export class ScheduleNotFoundError extends TaggedError(SCHEDULE_NOT_FOUND_ERROR_TAG, {
  name: "ScheduleNotFoundError",
})<{
  scheduleId: string;
  cause?: unknown;
}> {
  constructor(scheduleId: string, cause?: unknown) {
    super({ scheduleId, cause });
    this.message = `Schedule "${scheduleId}" not found on the Temporal server.`;
  }
}
