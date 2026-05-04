import type { StandardSchemaV1 } from "@standard-schema/spec";
import { summarizeIssues } from "./format.js";

/**
 * Base error class for worker errors
 */
abstract class WorkerError extends Error {
  protected constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "WorkerError";
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error thrown when an activity definition is not found in the contract
 */
export class ActivityDefinitionNotFoundError extends WorkerError {
  constructor(
    public readonly activityName: string,
    public readonly availableDefinitions: readonly string[] = [],
  ) {
    const available = availableDefinitions.length > 0 ? availableDefinitions.join(", ") : "none";
    super(
      `Activity definition not found for: "${activityName}". Available activities: ${available}`,
    );
    this.name = "ActivityDefinitionNotFoundError";
  }
}

/**
 * Error thrown when activity input validation fails
 */
export class ActivityInputValidationError extends WorkerError {
  constructor(
    public readonly activityName: string,
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(`Activity "${activityName}" input validation failed: ${message}`);
    this.name = "ActivityInputValidationError";
  }
}

/**
 * Error thrown when activity output validation fails
 */
export class ActivityOutputValidationError extends WorkerError {
  constructor(
    public readonly activityName: string,
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(`Activity "${activityName}" output validation failed: ${message}`);
    this.name = "ActivityOutputValidationError";
  }
}

/**
 * Error thrown when workflow input validation fails
 */
export class WorkflowInputValidationError extends WorkerError {
  constructor(
    public readonly workflowName: string,
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(`Workflow "${workflowName}" input validation failed: ${message}`);
    this.name = "WorkflowInputValidationError";
  }
}

/**
 * Error thrown when workflow output validation fails
 */
export class WorkflowOutputValidationError extends WorkerError {
  constructor(
    public readonly workflowName: string,
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(`Workflow "${workflowName}" output validation failed: ${message}`);
    this.name = "WorkflowOutputValidationError";
  }
}

/**
 * Error thrown when signal input validation fails
 */
export class SignalInputValidationError extends WorkerError {
  constructor(
    public readonly signalName: string,
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(`Signal "${signalName}" input validation failed: ${message}`);
    this.name = "SignalInputValidationError";
  }
}

/**
 * Error thrown when query input validation fails
 */
export class QueryInputValidationError extends WorkerError {
  constructor(
    public readonly queryName: string,
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(`Query "${queryName}" input validation failed: ${message}`);
    this.name = "QueryInputValidationError";
  }
}

/**
 * Error thrown when query output validation fails
 */
export class QueryOutputValidationError extends WorkerError {
  constructor(
    public readonly queryName: string,
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(`Query "${queryName}" output validation failed: ${message}`);
    this.name = "QueryOutputValidationError";
  }
}

/**
 * Error thrown when update input validation fails
 */
export class UpdateInputValidationError extends WorkerError {
  constructor(
    public readonly updateName: string,
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(`Update "${updateName}" input validation failed: ${message}`);
    this.name = "UpdateInputValidationError";
  }
}

/**
 * Error thrown when update output validation fails
 */
export class UpdateOutputValidationError extends WorkerError {
  constructor(
    public readonly updateName: string,
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(`Update "${updateName}" output validation failed: ${message}`);
    this.name = "UpdateOutputValidationError";
  }
}

/**
 * Error thrown when a child workflow is not found in the contract
 */
export class ChildWorkflowNotFoundError extends WorkerError {
  constructor(
    public readonly workflowName: string,
    public readonly availableWorkflows: readonly string[] = [],
  ) {
    const available = availableWorkflows.length > 0 ? availableWorkflows.join(", ") : "none";
    super(`Child workflow not found: "${workflowName}". Available workflows: ${available}`);
    this.name = "ChildWorkflowNotFoundError";
  }
}

/**
 * Generic error for child workflow operations.
 *
 * When the child execution itself fails (Temporal's `ChildWorkflowFailure`),
 * `cause` is set to the *unwrapped* underlying failure (`ApplicationFailure`,
 * `TimeoutFailure`, `TerminatedFailure`, etc.) lifted from Temporal's wrapper —
 * mirroring the client-side `WorkflowFailedError.cause` behavior, so callers
 * can branch on the failure category in one step instead of unwrapping twice.
 */
export class ChildWorkflowError extends WorkerError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ChildWorkflowError";
  }
}

/**
 * Discriminated variant of {@link ChildWorkflowError} surfaced when a child
 * workflow operation (start, execute, or wait-for-result) was cancelled —
 * either because the parent workflow itself was cancelled, the child was
 * explicitly cancelled, or its enclosing cancellation scope was. Detected via
 * `@temporalio/workflow`'s `isCancellation(...)`, which sees through nested
 * `ChildWorkflowFailure` / `CancelledFailure` chains.
 *
 * Distinct from `ChildWorkflowError` so call sites can branch on cancellation
 * explicitly without inspecting `error.cause` against a Temporal SDK class —
 * the worker-side analogue of the client-side cause-forwarding pattern.
 */
export class ChildWorkflowCancelledError extends WorkerError {
  constructor(
    public readonly childWorkflowName: string,
    cause?: unknown,
  ) {
    super(`Child workflow "${childWorkflowName}" was cancelled`, cause);
    this.name = "ChildWorkflowCancelledError";
  }
}

/**
 * Error surfaced in the `err(...)` branch of a `ResultAsync` when a typed
 * cancellation scope is cancelled via Temporal's cancellation propagation.
 * Returned by both `context.cancellableScope` (when the workflow or an
 * ancestor scope cancels) and `context.nonCancellableScope` (when
 * cancellation is raised from inside the scope). Distinct from arbitrary
 * thrown errors so call sites can branch on cancellation explicitly while
 * still surfacing non-cancellation errors as ResultAsync rejections.
 */
export class WorkflowCancelledError extends WorkerError {
  constructor(cause?: unknown) {
    super("Workflow cancellation scope was cancelled", cause);
    this.name = "WorkflowCancelledError";
  }
}
