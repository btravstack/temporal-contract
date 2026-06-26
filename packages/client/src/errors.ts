import type { StandardSchemaV1 } from "@standard-schema/spec";
import { summarizeIssues } from "@temporal-contract/contract";
import { TaggedError } from "unthrown";
import type {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  ChildWorkflowFailure,
  ServerFailure,
  TerminatedFailure,
  TimeoutFailure,
} from "@temporalio/common";

/**
 * Union of the actionable Temporal failure types that can surface as the
 * `cause` of a `WorkflowFailedError`. These all extend Temporal's internal
 * `TemporalFailure` base class — we list them by leaf type rather than by
 * the base class so consumer code can use a single `switch (true)` over
 * `instanceof` discriminants without an exhaustiveness escape hatch.
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
 * Generic runtime failure wrapper when no specific error type applies
 */
export class RuntimeClientError extends TaggedError("RuntimeClientError")<{
  operation: string;
  cause?: unknown;
  message: string;
}> {
  constructor(operation: string, cause?: unknown) {
    super({
      operation,
      cause,
      message: `Operation "${operation}" failed: ${
        cause instanceof Error ? cause.message : String(cause ?? "unknown error")
      }`,
    });
  }
}

/**
 * Thrown when a workflow is not found in the contract
 */
export class WorkflowNotFoundError extends TaggedError("WorkflowNotFoundError")<{
  workflowName: string;
  availableWorkflows: string[];
  message: string;
}> {
  constructor(workflowName: string, availableWorkflows: string[]) {
    super({
      workflowName,
      availableWorkflows,
      message: `Workflow "${workflowName}" not found in contract. Available workflows: ${availableWorkflows.join(", ")}`,
    });
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
export class WorkflowAlreadyStartedError extends TaggedError("WorkflowAlreadyStartedError")<{
  workflowType: string;
  workflowId: string;
  cause?: unknown;
  message: string;
}> {
  constructor(workflowType: string, workflowId: string, cause?: unknown) {
    super({
      workflowType,
      workflowId,
      cause,
      message: `Workflow "${workflowType}" with ID "${workflowId}" is already started or in retention.`,
    });
  }
}

/**
 * Discriminated variant of {@link RuntimeClientError} surfaced when an
 * operation targets a workflow execution that doesn't exist in the
 * namespace — Temporal's `WorkflowNotFoundError` (distinct from this
 * package's contract-level {@link WorkflowNotFoundError}).
 *
 * Returned from:
 * - handle methods: `signal`, `query`, `executeUpdate`, `result`,
 *   `terminate`, `cancel`, `describe`, `fetchHistory`
 * - `executeWorkflow` (when the underlying execute call hits a missing
 *   execution mid-flight)
 */
export class WorkflowExecutionNotFoundError extends TaggedError("WorkflowExecutionNotFoundError")<{
  workflowId: string;
  runId?: string | undefined;
  cause?: unknown;
  message: string;
}> {
  constructor(workflowId: string, runId?: string, cause?: unknown) {
    super({
      workflowId,
      runId,
      cause,
      message: `Workflow execution "${workflowId}"${runId ? ` (run "${runId}")` : ""} not found in namespace.`,
    });
  }
}

/**
 * Discriminated variant of {@link RuntimeClientError} surfaced when waiting
 * on a workflow's result and the workflow completes with a failure —
 * Temporal's `WorkflowFailedError`.
 *
 * `cause` is the *unwrapped* underlying {@link TemporalFailure} (typically an
 * `ApplicationFailure`, `CancelledFailure`, `TerminatedFailure`, or
 * `TimeoutFailure`) lifted from Temporal's wrapper, so callers can branch
 * on the failure category in one step (`err.cause instanceof
 * ApplicationFailure`) instead of unwrapping twice via the SDK wrapper. The
 * SDK declares `WorkflowFailedError.cause` as the wider `Error | undefined`
 * (since `cause` lives on `Error`), but the runtime guarantee — driven by
 * Temporal's wire format — is that it is always a `TemporalFailure` subclass
 * when the wrapper is surfaced. `classifyResultError` narrows that wider
 * static type to the public {@link TemporalFailure} union with a cast, so
 * consumers see the precise leaf-failure typing instead of a bare `Error`.
 *
 * Returned from `executeWorkflow` and `handle.result()`.
 */
export class WorkflowFailedError extends TaggedError("WorkflowFailedError")<{
  workflowId: string;
  cause?: TemporalFailure | undefined;
  message: string;
}> {
  constructor(workflowId: string, cause?: TemporalFailure) {
    const causeMessage =
      cause instanceof Error ? cause.message : String(cause ?? "unknown failure");
    super({
      workflowId,
      cause,
      message: `Workflow "${workflowId}" completed with failure: ${causeMessage}`,
    });
  }
}

// Validation-message formatters live in `@temporal-contract/contract` so
// client and worker share a single source of truth. The previous local
// copies have been removed in favor of the shared `summarizeIssues` import
// at the top of this module.

/**
 * Thrown when workflow input or output validation fails
 */
export class WorkflowValidationError extends TaggedError("WorkflowValidationError")<{
  workflowName: string;
  direction: "input" | "output";
  issues: ReadonlyArray<StandardSchemaV1.Issue>;
  message: string;
}> {
  constructor(
    workflowName: string,
    direction: "input" | "output",
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    super({
      workflowName,
      direction,
      issues,
      message: `Validation failed for workflow "${workflowName}" ${direction}: ${summarizeIssues(issues)}`,
    });
  }
}

/**
 * Thrown when query input or output validation fails
 */
export class QueryValidationError extends TaggedError("QueryValidationError")<{
  queryName: string;
  direction: "input" | "output";
  issues: ReadonlyArray<StandardSchemaV1.Issue>;
  message: string;
}> {
  constructor(
    queryName: string,
    direction: "input" | "output",
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    super({
      queryName,
      direction,
      issues,
      message: `Validation failed for query "${queryName}" ${direction}: ${summarizeIssues(issues)}`,
    });
  }
}

/**
 * Thrown when signal input validation fails
 */
export class SignalValidationError extends TaggedError("SignalValidationError")<{
  signalName: string;
  issues: ReadonlyArray<StandardSchemaV1.Issue>;
  message: string;
}> {
  constructor(signalName: string, issues: ReadonlyArray<StandardSchemaV1.Issue>) {
    super({
      signalName,
      issues,
      message: `Validation failed for signal "${signalName}": ${summarizeIssues(issues)}`,
    });
  }
}

/**
 * Thrown when update input or output validation fails
 */
export class UpdateValidationError extends TaggedError("UpdateValidationError")<{
  updateName: string;
  direction: "input" | "output";
  issues: ReadonlyArray<StandardSchemaV1.Issue>;
  message: string;
}> {
  constructor(
    updateName: string,
    direction: "input" | "output",
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    super({
      updateName,
      direction,
      issues,
      message: `Validation failed for update "${updateName}" ${direction}: ${summarizeIssues(issues)}`,
    });
  }
}
