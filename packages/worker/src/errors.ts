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
 * Generic error for child workflow operations
 */
export class ChildWorkflowError extends WorkerError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ChildWorkflowError";
  }
}
