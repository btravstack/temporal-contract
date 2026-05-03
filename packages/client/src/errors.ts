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

/**
 * Pattern for string keys safe to render with dot notation. A "safe" key is a
 * JavaScript identifier (letters/digits/underscore/$, not starting with a
 * digit). Anything else — keys containing dots, spaces, leading digits, the
 * empty string, the literal string `"0"` etc. — gets bracket-quoted so the
 * path is unambiguous.
 *
 * This helper is intentionally duplicated with the worker package so each
 * entry point is self-contained; keep the two copies in sync.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Render a Standard Schema {@link StandardSchemaV1.Issue} into a human-readable
 * string that includes the failing field's path.
 *
 * Example output:
 * - `at items[0].quantity: Expected number, received undefined`
 * - `at customerId: Expected string, received undefined`
 * - `at user["first name"]: Expected string, received undefined`
 * - `Validation error` *(no path)*
 *
 * Path segments come either as bare `PropertyKey` values or as
 * `{ key: PropertyKey }` objects (per the spec); both are normalized.
 * - Numeric keys → `[N]`
 * - String keys that are valid JS identifiers → bare (first) or `.key`
 * - String keys that aren't valid identifiers → `["..."]` with JSON-style
 *   escaping (handles dots, spaces, leading digits, the empty string, the
 *   literal string `"0"`, embedded quotes, etc.)
 * - Symbol / other `PropertyKey` → `[Symbol(name)]`
 */
function formatIssue(issue: StandardSchemaV1.Issue): string {
  if (issue.path === undefined || issue.path.length === 0) {
    return issue.message;
  }
  let path = "";
  for (let i = 0; i < issue.path.length; i++) {
    const segment = issue.path[i];
    const key =
      segment !== null && typeof segment === "object" && "key" in segment ? segment.key : segment;
    if (typeof key === "number") {
      path += `[${key}]`;
    } else if (typeof key === "string" && SAFE_IDENTIFIER.test(key)) {
      path += i === 0 ? key : `.${key}`;
    } else if (typeof key === "string") {
      // Non-identifier string: bracket-quote with JSON-style escaping so
      // dots, spaces, embedded quotes, and the literal string `"0"` are
      // unambiguous from numeric indices and identifier segments.
      path += `[${JSON.stringify(key)}]`;
    } else {
      // Symbol or other PropertyKey — bracket-stringify so it parses
      // unambiguously alongside string segments.
      path += `[${String(key)}]`;
    }
  }
  return `at ${path}: ${issue.message}`;
}

function summarizeIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): string {
  return issues.map(formatIssue).join("; ");
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
