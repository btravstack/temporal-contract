import type { StandardSchemaV1 } from "@standard-schema/spec";
import { summarizeIssues } from "@temporal-contract/contract";
import { ApplicationFailure } from "@temporalio/common";
import { TaggedError } from "unthrown";

/**
 * Base class for the contract's runtime validation failures — workflow and
 * activity input/output, plus signal/query/update payloads.
 *
 * These extend Temporal's {@link ApplicationFailure} with `nonRetryable: true`
 * rather than a plain `Error`, and that distinction is load-bearing. The
 * TypeScript SDK classifies a non-`TemporalFailure` thrown from *workflow* code
 * as a Workflow Task failure — presumed to be a transient code bug or
 * non-determinism — and retries the task indefinitely, leaving the execution
 * silently `Running` forever (it looks like the worker "hung"). Only a
 * `TemporalFailure` such as `ApplicationFailure` fails the Workflow Execution
 * terminally. The same logic applies at the activity boundary, where Temporal's
 * default retry policy has unlimited attempts: a plain `Error` would retry
 * forever too.
 *
 * Contract validation failures are deterministic — the schema is static, so bad
 * input/output never becomes valid on replay or retry — so they are surfaced as
 * non-retryable, failing fast with a clear error instead of an infinite retry
 * loop.
 *
 * The concrete subclass name is passed through as the failure `type`, so it
 * stays discriminable after crossing Temporal's serialization boundary (where
 * the JS class identity is lost) via `failure.type`. The failing field path is
 * carried in the human-readable `message` (see {@link summarizeIssues}). The
 * raw `issues` remain available as a property for in-process inspection.
 *
 * See issue #251.
 */
export abstract class ValidationError extends ApplicationFailure {
  protected constructor(
    message: string,
    type: string,
    public readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    // (message, type, nonRetryable) — terminal, deterministic failure.
    super(message, type, true);
    // `ApplicationFailure`'s `SymbolBasedInstanceOfError` decorator installs a
    // read-only `name` ("ApplicationFailure") on the prototype, so a plain
    // `this.name = type` assignment throws. Define an own property to shadow it
    // and surface the concrete subclass name (matching `type`). `writable: true`
    // keeps the field reassignable, matching the previous `this.name = ...`
    // behaviour so consumers (e.g. error-wrapping code) can still adjust it.
    Object.defineProperty(this, "name", {
      value: type,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error thrown when an activity definition is not found in the contract
 */
export class ActivityDefinitionNotFoundError extends TaggedError(
  "@temporal-contract/ActivityDefinitionNotFoundError",
  { name: "ActivityDefinitionNotFoundError" },
)<{
  activityName: string;
  availableDefinitions: readonly string[];
  message: string;
}> {
  constructor(activityName: string, availableDefinitions: readonly string[] = []) {
    const available = availableDefinitions.length > 0 ? availableDefinitions.join(", ") : "none";
    super({
      activityName,
      availableDefinitions,
      message: `Activity definition not found for: "${activityName}". Available activities: ${available}`,
    });
  }
}

/**
 * Error thrown when activity input validation fails
 */
export class ActivityInputValidationError extends ValidationError {
  constructor(
    public readonly activityName: string,
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(
      `Activity "${activityName}" input validation failed: ${message}`,
      "ActivityInputValidationError",
      issues,
    );
  }
}

/**
 * Error thrown when activity output validation fails
 */
export class ActivityOutputValidationError extends ValidationError {
  constructor(
    public readonly activityName: string,
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(
      `Activity "${activityName}" output validation failed: ${message}`,
      "ActivityOutputValidationError",
      issues,
    );
  }
}

/**
 * Error thrown when workflow input validation fails
 */
export class WorkflowInputValidationError extends ValidationError {
  constructor(
    public readonly workflowName: string,
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(
      `Workflow "${workflowName}" input validation failed: ${message}`,
      "WorkflowInputValidationError",
      issues,
    );
  }
}

/**
 * Error thrown when workflow output validation fails
 */
export class WorkflowOutputValidationError extends ValidationError {
  constructor(
    public readonly workflowName: string,
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(
      `Workflow "${workflowName}" output validation failed: ${message}`,
      "WorkflowOutputValidationError",
      issues,
    );
  }
}

/**
 * Error thrown when signal input validation fails
 */
export class SignalInputValidationError extends ValidationError {
  constructor(
    public readonly signalName: string,
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(
      `Signal "${signalName}" input validation failed: ${message}`,
      "SignalInputValidationError",
      issues,
    );
  }
}

/**
 * Error thrown when query input validation fails
 */
export class QueryInputValidationError extends ValidationError {
  constructor(
    public readonly queryName: string,
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(
      `Query "${queryName}" input validation failed: ${message}`,
      "QueryInputValidationError",
      issues,
    );
  }
}

/**
 * Error thrown when query output validation fails
 */
export class QueryOutputValidationError extends ValidationError {
  constructor(
    public readonly queryName: string,
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(
      `Query "${queryName}" output validation failed: ${message}`,
      "QueryOutputValidationError",
      issues,
    );
  }
}

/**
 * Error thrown when update input validation fails
 */
export class UpdateInputValidationError extends ValidationError {
  constructor(
    public readonly updateName: string,
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(
      `Update "${updateName}" input validation failed: ${message}`,
      "UpdateInputValidationError",
      issues,
    );
  }
}

/**
 * Error thrown when update output validation fails
 */
export class UpdateOutputValidationError extends ValidationError {
  constructor(
    public readonly updateName: string,
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(
      `Update "${updateName}" output validation failed: ${message}`,
      "UpdateOutputValidationError",
      issues,
    );
  }
}

/**
 * Error thrown when a child workflow is not found in the contract
 */
export class ChildWorkflowNotFoundError extends TaggedError(
  "@temporal-contract/ChildWorkflowNotFoundError",
  { name: "ChildWorkflowNotFoundError" },
)<{
  workflowName: string;
  availableWorkflows: readonly string[];
  message: string;
}> {
  constructor(workflowName: string, availableWorkflows: readonly string[] = []) {
    const available = availableWorkflows.length > 0 ? availableWorkflows.join(", ") : "none";
    super({
      workflowName,
      availableWorkflows,
      message: `Child workflow not found: "${workflowName}". Available workflows: ${available}`,
    });
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
export class ChildWorkflowError extends TaggedError("@temporal-contract/ChildWorkflowError", {
  name: "ChildWorkflowError",
})<{
  message: string;
  cause?: unknown;
}> {
  constructor(message: string, cause?: unknown) {
    super({ message, cause });
  }
}

/**
 * Discriminated variant surfaced when a child workflow operation (start,
 * execute, or wait-for-result) was cancelled — either because the parent
 * workflow itself was cancelled, the child was explicitly cancelled, or its
 * enclosing cancellation scope was. Detected via `@temporalio/workflow`'s
 * `isCancellation(...)`, which sees through nested `ChildWorkflowFailure` /
 * `CancelledFailure` chains.
 *
 * A sibling of {@link ChildWorkflowError} rather than a subclass: both are
 * distinct {@link TaggedError}s, so call sites discriminate on the `_tag`
 * (or `instanceof ChildWorkflowCancelledError`) instead of relying on an
 * `instanceof ChildWorkflowError` that also matches cancellation. `matchTags`
 * folds the `ChildWorkflowError | ChildWorkflowCancelledError` union
 * exhaustively.
 */
export class ChildWorkflowCancelledError extends TaggedError(
  "@temporal-contract/ChildWorkflowCancelledError",
  { name: "ChildWorkflowCancelledError" },
)<{
  workflowName: string;
  cause?: unknown;
  message: string;
}> {
  constructor(workflowName: string, cause?: unknown) {
    super({ workflowName, cause, message: `Child workflow "${workflowName}" was cancelled` });
  }
}

/**
 * Error surfaced in the `Err(...)` branch of an `AsyncResult` when a typed
 * cancellation scope is cancelled via Temporal's cancellation propagation.
 * Returned by both `context.cancellableScope` (when the workflow or an
 * ancestor scope cancels) and `context.nonCancellableScope` (when
 * cancellation is raised from inside the scope). Distinct from arbitrary
 * thrown errors so call sites can branch on cancellation explicitly.
 *
 * Non-cancellation errors thrown inside a scope are *unmodeled* failures: they
 * surface on the scope's `defect` channel (re-thrown at the edge / inspectable
 * via `result.isDefect()` and `result.cause`), not as a typed `Err(...)`.
 */
export class WorkflowCancelledError extends TaggedError(
  "@temporal-contract/WorkflowCancelledError",
  { name: "WorkflowCancelledError" },
)<{
  cause?: unknown;
  message: string;
}> {
  constructor(cause?: unknown) {
    super({ cause, message: "Workflow cancellation scope was cancelled" });
  }
}
