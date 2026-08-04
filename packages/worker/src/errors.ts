import type { StandardSchemaV1 } from "@standard-schema/spec";
import { summarizeIssues } from "@temporal-contract/contract";
import { ApplicationFailure } from "@temporalio/common";
import { TaggedError } from "unthrown";

import {
  ACTIVITY_CANCELLED_ERROR_TAG,
  ACTIVITY_DEFINITION_NOT_FOUND_ERROR_TAG,
  ACTIVITY_ERROR_TAG,
  CHILD_WORKFLOW_CANCELLED_ERROR_TAG,
  CHILD_WORKFLOW_ERROR_TAG,
  CHILD_WORKFLOW_NOT_FOUND_ERROR_TAG,
  WORKFLOW_CANCELLED_ERROR_TAG,
} from "./error-tags.js";

// Cancellation caveat (module-wide): the cancellation error classes below
// ({@link ActivityCancelledError}, {@link ChildWorkflowCancelledError},
// {@link WorkflowCancelledError}) surface Temporal cancellation on the
// modeled `Err(...)` channel of an `AsyncResult`. That makes cancellation
// explicit — but it also means *generic* error handling can swallow it: a
// workflow that maps every `Err` to a "failed" result and returns normally
// completes as `Completed`, not `Cancelled`, even though the server asked
// for cancellation. When a workflow does not intend to absorb cancellation,
// re-raise it with {@link rethrowCancellation} so Temporal records the
// execution as `Cancelled`.

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
  ACTIVITY_DEFINITION_NOT_FOUND_ERROR_TAG,
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
  /** Which side of the payload boundary failed — aligns with the client's direction-as-field error family. */
  public readonly direction = "input" as const;

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
  /** Which side of the payload boundary failed — aligns with the client's direction-as-field error family. */
  public readonly direction = "output" as const;

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
  /** Which side of the payload boundary failed — aligns with the client's direction-as-field error family. */
  public readonly direction = "input" as const;

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
  /** Which side of the payload boundary failed — aligns with the client's direction-as-field error family. */
  public readonly direction = "output" as const;

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
  /** Which side of the payload boundary failed — aligns with the client's direction-as-field error family. */
  public readonly direction = "input" as const;

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
  /** Which side of the payload boundary failed — aligns with the client's direction-as-field error family. */
  public readonly direction = "output" as const;

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
  /** Which side of the payload boundary failed — aligns with the client's direction-as-field error family. */
  public readonly direction = "input" as const;

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
  /** Which side of the payload boundary failed — aligns with the client's direction-as-field error family. */
  public readonly direction = "output" as const;

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
 * Every activity call surfaces this — the workflow-side call convention no
 * longer depends on whether the contract declares an `errors` map; only the
 * error channel's declared-error members do.
 *
 * `originalFailure` is a second, separate retention: the value exactly as it
 * was caught, *before* `classifyActivityError` unwrapped it into `cause`
 * (typically Temporal's `ActivityFailure` wrapper). `cause`'s unwrapping is
 * documented, caller-facing behavior and stays as-is — `originalFailure`
 * exists purely so {@link propagateActivityFailure} can re-raise the exact
 * failure Temporal originally produced, without changing what `cause` means.
 * Unset when there is no separate wrapper to retain (e.g. the input/output
 * validation branches, where `cause` is already the terminal failure).
 */
export class ActivityError extends TaggedError(ACTIVITY_ERROR_TAG, {
  name: "ActivityError",
})<{
  activityName: string;
  cause?: unknown;
  originalFailure?: unknown;
}> {
  constructor(activityName: string, message: string, cause?: unknown, originalFailure?: unknown) {
    super({ activityName, cause, originalFailure });
    this.message = message;
  }
}

/**
 * Discriminated variant surfaced when a call to an activity was cancelled
 * (the workflow itself, or an enclosing cancellation scope) — every activity
 * call rides this branch now, not only ones that declare an `errors` map.
 * Detected via `@temporalio/workflow`'s `isCancellation(...)`.
 *
 * A sibling of {@link ActivityError} rather than a subclass, for the same
 * reason {@link ChildWorkflowCancelledError} is a sibling of
 * {@link ChildWorkflowError}: call sites discriminate on the `_tag`.
 *
 * **Swallowing this error changes the workflow outcome.** Cancellation rides
 * the modeled `Err(...)` channel here, so generic error handling (e.g.
 * mapping every `Err` to a "failed" result and returning normally) makes the
 * workflow complete as `Completed` instead of `Cancelled`. When the workflow
 * should honor the cancellation request, re-raise it with
 * {@link rethrowCancellation}.
 *
 * Unlike {@link ActivityError}, `cause` here is already the value exactly as
 * caught (`classifyActivityError` checks cancellation *before* unwrapping
 * `ActivityFailure`) — so there is no separate `originalFailure` to retain;
 * {@link propagateActivityFailure} re-raises `cause` directly.
 */
export class ActivityCancelledError extends TaggedError(ACTIVITY_CANCELLED_ERROR_TAG, {
  name: "ActivityCancelledError",
})<{
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
export class ChildWorkflowNotFoundError extends TaggedError(CHILD_WORKFLOW_NOT_FOUND_ERROR_TAG, {
  name: "ChildWorkflowNotFoundError",
})<{
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
 *
 * Carries the child's `workflowName` as a structured field (matching its
 * sibling {@link ChildWorkflowCancelledError}) so callers don't have to parse
 * it out of `message`.
 */
export class ChildWorkflowError extends TaggedError(CHILD_WORKFLOW_ERROR_TAG, {
  name: "ChildWorkflowError",
})<{
  workflowName: string;
  cause?: unknown;
}> {
  constructor(workflowName: string, message: string, cause?: unknown) {
    super({ workflowName, cause });
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
 *
 * **Swallowing this error changes the workflow outcome.** Cancellation rides
 * the modeled `Err(...)` channel here, so generic error handling (e.g.
 * mapping every `Err` to a "failed" result and returning normally) makes the
 * parent workflow complete as `Completed` instead of `Cancelled`. When the
 * workflow should honor the cancellation request, re-raise it with
 * {@link rethrowCancellation}.
 */
export class ChildWorkflowCancelledError extends TaggedError(CHILD_WORKFLOW_CANCELLED_ERROR_TAG, {
  name: "ChildWorkflowCancelledError",
})<{
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
 *
 * **Swallowing this error changes the workflow outcome.** Cancellation rides
 * the modeled `Err(...)` channel here, so generic error handling (e.g.
 * mapping every `Err` to a "failed" result and returning normally) makes the
 * workflow complete as `Completed` instead of `Cancelled`. When the workflow
 * should honor the cancellation request after cleanup, re-raise it with
 * {@link rethrowCancellation}.
 */
export class WorkflowCancelledError extends TaggedError(WORKFLOW_CANCELLED_ERROR_TAG, {
  name: "WorkflowCancelledError",
})<{
  cause?: unknown;
}> {
  constructor(cause?: unknown) {
    super({ cause });
    this.message = "Workflow cancellation scope was cancelled";
  }
}

/**
 * Re-raise a cancellation error surfaced on the modeled `Err(...)` channel so
 * Temporal records the workflow execution as `Cancelled`.
 *
 * The typed surfaces fold Temporal cancellation into
 * `Err(ActivityCancelledError | WorkflowCancelledError |
 * ChildWorkflowCancelledError)`. That is deliberate — cancellation becomes an
 * explicit branch — but it has a footgun: generic error handling that maps
 * every `Err` to a domain "failed" outcome and returns normally makes the
 * workflow complete as `Completed`, silently overriding the server's
 * cancellation request. When the workflow should *honor* the cancellation
 * (typically after `nonCancellableScope` cleanup), call this helper: it
 * throws the original `CancelledFailure` carried in `error.cause` (or the
 * error itself when no cause was attached), which Temporal recognizes and
 * turns into a `Cancelled` workflow outcome.
 *
 * Workflow-sandbox safe: no I/O, no wall clock — it only rethrows.
 *
 * @example
 * ```ts
 * // `fn`'s return value becomes the scope's `T` verbatim, so await and
 * // narrow the activity's own AsyncResult HERE, inside the callback —
 * // returning it un-awaited would make `T` the AsyncResult itself, which
 * // has no `isOk`/`isErr`/`.value`.
 * const result = await context.cancellableScope(async () => {
 *   const step = await context.activities.processStep(args);
 *   if (step.isDefect()) {
 *     throw step.cause;
 *   }
 *   return step.isOk();
 * });
 * if (result.isDefect()) {
 *   throw result.cause; // a genuine bug thrown inside the scope, not a cancel
 * }
 * if (result.isErr()) {
 *   // Capture nonCancellableScope's OWN AsyncResult too — a bare `await`
 *   // would silently discard a defect thrown during cleanup.
 *   const released = await context.nonCancellableScope(async () => {
 *     const step = await context.activities.releaseResources(args);
 *     if (step.isErr()) {
 *       // best-effort cleanup — log and continue regardless
 *     }
 *   });
 *   if (released.isDefect()) {
 *     throw released.cause; // a genuine bug in cleanup, not a cancel
 *   }
 *   // Honor the cancellation instead of completing normally:
 *   rethrowCancellation(result.error);
 * }
 * ```
 */
export function rethrowCancellation(
  error: ActivityCancelledError | ChildWorkflowCancelledError | WorkflowCancelledError,
): never {
  // oxlint-disable-next-line unthrown/no-throw -- sanctioned cancellation re-raise: the original CancelledFailure must reach Temporal so the execution ends Cancelled (CLAUDE.md rule 2 exception)
  throw error.cause ?? error;
}
