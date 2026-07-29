import type { StandardSchemaV1 } from "@standard-schema/spec";
import { summarizeIssues } from "@temporal-contract/contract";
import { ApplicationFailure } from "@temporalio/common";
import { TaggedError } from "unthrown";

/**
 * Base class for the contract's runtime validation failures — workflow and
 * activity input/output, plus query/update payloads. (Invalid *signal*
 * payloads are not errors: signals are fire-and-forget, so the worker drops
 * and logs them instead of failing the execution.)
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
    // `enumerable: false` matches plain-`Error` semantics — `name` shouldn't
    // show up in `Object.keys(...)` / spread / JSON serialization of the error.
    Object.defineProperty(this, "name", {
      value: type,
      writable: true,
      configurable: true,
      enumerable: false,
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
}> {
  constructor(activityName: string, availableDefinitions: readonly string[] = []) {
    const available = availableDefinitions.length > 0 ? availableDefinitions.join(", ") : "none";
    super({ activityName, availableDefinitions });
    this.message = `Activity definition not found for: "${activityName}". Available activities: ${available}`;
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
 * Error thrown when a contract-declared error's `data` payload fails
 * validation against its declared schema at the Temporal boundary, or when
 * an implementation surfaces a `ContractError` whose name isn't declared on
 * its activity/workflow. Both are deterministic contract-misuse bugs, so the
 * failure is terminal (`nonRetryable`) like the other validation errors.
 */
export class ContractErrorDataValidationError extends ValidationError {
  constructor(
    public readonly errorName: string,
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) {
    const message = summarizeIssues(issues);
    super(
      `Contract error "${errorName}" data validation failed: ${message}`,
      "ContractErrorDataValidationError",
      issues,
    );
  }
}

/**
 * Error thrown when workflow-sandbox code misuses the contract surface —
 * binding a signal/query/update handler for a name the contract doesn't
 * declare, using an async-validating schema where Temporal requires
 * synchronous validation, or reaching an activity that no options cover.
 *
 * Extends {@link ValidationError} for the same load-bearing reason as its
 * siblings: a plain `Error` thrown from *workflow* code is classified by the
 * TypeScript SDK as a Workflow Task failure and retried indefinitely,
 * leaving the execution silently `Running` forever. Contract misuse is a
 * deterministic programming bug — it never becomes valid on replay — so it
 * must fail the Workflow Execution terminally as a non-retryable
 * `ApplicationFailure` with a clear message, not hang in an infinite
 * Workflow Task retry loop.
 *
 * Carries no schema `issues` (the misuse is structural, not a payload
 * validation failure), so the `issues` array is always empty.
 */
export class ContractMisuseError extends ValidationError {
  constructor(message: string) {
    super(message, "ContractMisuseError", []);
  }
}

/**
 * Generic error surfaced on the `Err(...)` branch when an activity that
 * declares contract errors fails for a reason *other* than one of its
 * declared errors — retries exhausted on a technical failure, a timeout, an
 * undeclared `ApplicationFailure` type, or a validation failure at the
 * workflow → activity boundary.
 *
 * Mirrors {@link ChildWorkflowError}: `cause` is the *unwrapped* actionable
 * failure (Temporal's `ActivityFailure` wrapper is seen through), so callers
 * can branch on the failure category in one step.
 *
 * Only activities that declare an `errors` map surface this — activities
 * without declared errors keep Temporal's native throwing behavior.
 */
export class ActivityError extends TaggedError("@temporal-contract/ActivityError", {
  name: "ActivityError",
})<{
  activityName: string;
  cause?: unknown;
}> {
  constructor(activityName: string, message: string, cause?: unknown) {
    super({ activityName, cause });
    this.message = message;
  }
}

/**
 * Discriminated variant surfaced when a call to an errors-declaring activity
 * was cancelled (the workflow itself, or an enclosing cancellation scope).
 * Detected via `@temporalio/workflow`'s `isCancellation(...)`.
 *
 * A sibling of {@link ActivityError} rather than a subclass, for the same
 * reason {@link ChildWorkflowCancelledError} is a sibling of
 * {@link ChildWorkflowError}: call sites discriminate on the `_tag`.
 */
export class ActivityCancelledError extends TaggedError(
  "@temporal-contract/ActivityCancelledError",
  { name: "ActivityCancelledError" },
)<{
  activityName: string;
  cause?: unknown;
}> {
  constructor(activityName: string, cause?: unknown) {
    super({ activityName, cause });
    this.message = `Activity "${activityName}" was cancelled`;
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
}> {
  constructor(workflowName: string, availableWorkflows: readonly string[] = []) {
    const available = availableWorkflows.length > 0 ? availableWorkflows.join(", ") : "none";
    super({ workflowName, availableWorkflows });
    this.message = `Child workflow not found: "${workflowName}". Available workflows: ${available}`;
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
  cause?: unknown;
}> {
  constructor(message: string, cause?: unknown) {
    super({ cause });
    this.message = message;
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
 * `instanceof ChildWorkflowError` that also matches cancellation. A
 * `result.match` with the exhaustive `errCases` matcher folds the
 * `ChildWorkflowError | ChildWorkflowCancelledError` union exhaustively.
 */
export class ChildWorkflowCancelledError extends TaggedError(
  "@temporal-contract/ChildWorkflowCancelledError",
  { name: "ChildWorkflowCancelledError" },
)<{
  workflowName: string;
  cause?: unknown;
}> {
  constructor(workflowName: string, cause?: unknown) {
    super({ workflowName, cause });
    this.message = `Child workflow "${workflowName}" was cancelled`;
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
}> {
  constructor(cause?: unknown) {
    super({ cause });
    this.message = "Workflow cancellation scope was cancelled";
  }
}
