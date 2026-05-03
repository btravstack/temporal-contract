import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Base class for all typed client errors with boxed pattern
 */
abstract class TypedClientError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Generic runtime failure wrapper when no specific error type applies
 */
export class RuntimeClientError extends TypedClientError {
  constructor(
    public readonly operation: string,
    public override readonly cause?: unknown,
  ) {
    super(
      `Operation "${operation}" failed: ${
        cause instanceof Error ? cause.message : String(cause ?? "unknown error")
      }`,
    );
  }
}

/**
 * Thrown when a workflow is not found in the contract
 */
export class WorkflowNotFoundError extends TypedClientError {
  constructor(
    public readonly workflowName: string,
    public readonly availableWorkflows: string[],
  ) {
    super(
      `Workflow "${workflowName}" not found in contract. Available workflows: ${availableWorkflows.join(", ")}`,
    );
  }
}

function summarizeIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): string {
  return issues.map((issue) => issue.message).join("; ");
}

/**
 * Thrown when workflow input or output validation fails
 */
export class WorkflowValidationError extends TypedClientError {
  constructor(
    public readonly workflowName: string,
    public readonly direction: "input" | "output",
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    super(
      `Validation failed for workflow "${workflowName}" ${direction}: ${summarizeIssues(issues)}`,
    );
  }
}

/**
 * Thrown when query input or output validation fails
 */
export class QueryValidationError extends TypedClientError {
  constructor(
    public readonly queryName: string,
    public readonly direction: "input" | "output",
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    super(`Validation failed for query "${queryName}" ${direction}: ${summarizeIssues(issues)}`);
  }
}

/**
 * Thrown when signal input validation fails
 */
export class SignalValidationError extends TypedClientError {
  constructor(
    public readonly signalName: string,
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    super(`Validation failed for signal "${signalName}": ${summarizeIssues(issues)}`);
  }
}

/**
 * Thrown when update input or output validation fails
 */
export class UpdateValidationError extends TypedClientError {
  constructor(
    public readonly updateName: string,
    public readonly direction: "input" | "output",
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    super(`Validation failed for update "${updateName}" ${direction}: ${summarizeIssues(issues)}`);
  }
}
