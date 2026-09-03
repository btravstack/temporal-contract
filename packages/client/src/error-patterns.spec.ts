/**
 * Tests for the shipped pattern groups.
 *
 * Two things have to hold, and they fail in different ways:
 *
 * 1. **Each group covers its method's union** — checked at compile time by
 *    calling `.exhaustive()`, which is typed callable only once the builder's
 *    `Remaining` is `never`. A group that loses a member stops compiling
 *    here rather than silently narrowing what callers handle.
 * 2. **Each group is no *wider* than its union** — checked at runtime against
 *    the literal tag list. A group that gains a stray member would still
 *    compile (an unreachable pattern is legal) while quietly telling readers
 *    a method can produce something it cannot.
 */
import { match } from "unthrown";
import { describe, expect, it } from "vitest";

import {
  QUERY_PATTERNS,
  SCHEDULE_CREATE_PATTERNS,
  SIGNAL_PATTERNS,
  UPDATE_PATTERNS,
  WORKFLOW_EXECUTE_PATTERNS,
  WORKFLOW_RESULT_PATTERNS,
  WORKFLOW_START_PATTERNS,
  WORKFLOW_STOPPED_PATTERNS,
} from "./error-patterns.js";
import type {
  QueryFailedError,
  QueryValidationError,
  ScheduleAlreadyExistsError,
  SignalValidationError,
  UpdateFailedError,
  UpdateRejectedError,
  UpdateValidationError,
  WorkflowAlreadyStartedError,
  WorkflowCancelledError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
  WorkflowNotInContractError,
  WorkflowTerminatedError,
  WorkflowTimeoutError,
  WorkflowValidationError,
} from "./errors.js";

// The unions the client's own signatures produce, restated here so a change
// to either side has to be made deliberately on both.
type StartErrors =
  | WorkflowNotInContractError
  | WorkflowValidationError
  | WorkflowAlreadyStartedError;

type ResultErrors =
  | WorkflowValidationError
  | WorkflowFailedError
  | WorkflowCancelledError
  | WorkflowTerminatedError
  | WorkflowTimeoutError
  | WorkflowExecutionNotFoundError;

type ExecuteErrors = StartErrors | ResultErrors;
type StoppedErrors = WorkflowCancelledError | WorkflowTerminatedError | WorkflowTimeoutError;
type SignalErrors = SignalValidationError | WorkflowExecutionNotFoundError;
type QueryErrors = QueryValidationError | QueryFailedError | WorkflowExecutionNotFoundError;
type UpdateErrors =
  | UpdateValidationError
  | UpdateRejectedError
  | UpdateFailedError
  | WorkflowExecutionNotFoundError;
type ScheduleCreateErrors =
  | ScheduleAlreadyExistsError
  | WorkflowNotInContractError
  | WorkflowValidationError;

/**
 * Compile-time pins. Never invoked — `.exhaustive()` failing to typecheck is
 * the assertion, and `tsc` runs over this file.
 */
export function _typeLevelPins(): void {
  const start = (error: StartErrors) =>
    match(error)
      .with(...WORKFLOW_START_PATTERNS, () => "handled")
      .exhaustive();

  const result = (error: ResultErrors) =>
    match(error)
      .with(...WORKFLOW_RESULT_PATTERNS, () => "handled")
      .exhaustive();

  const execute = (error: ExecuteErrors) =>
    match(error)
      .with(...WORKFLOW_EXECUTE_PATTERNS, () => "handled")
      .exhaustive();

  const stopped = (error: StoppedErrors) =>
    match(error)
      .with(...WORKFLOW_STOPPED_PATTERNS, () => "handled")
      .exhaustive();

  const signal = (error: SignalErrors) =>
    match(error)
      .with(...SIGNAL_PATTERNS, () => "handled")
      .exhaustive();

  const query = (error: QueryErrors) =>
    match(error)
      .with(...QUERY_PATTERNS, () => "handled")
      .exhaustive();

  const update = (error: UpdateErrors) =>
    match(error)
      .with(...UPDATE_PATTERNS, () => "handled")
      .exhaustive();

  const schedule = (error: ScheduleCreateErrors) =>
    match(error)
      .with(...SCHEDULE_CREATE_PATTERNS, () => "handled")
      .exhaustive();

  // Grouping must not weaken exhaustiveness: the stopped trio is a strict
  // subset of the result union, so it must NOT satisfy it. If this stops
  // erroring, the groups have stopped being checked at all.
  const notExhaustive = (error: ResultErrors) =>
    match(error)
      .with(...WORKFLOW_STOPPED_PATTERNS, () => "handled")
      // @ts-expect-error -- WorkflowValidationError/FailedError/ExecutionNotFoundError remain
      .exhaustive();

  void [start, result, execute, stopped, signal, query, update, schedule, notExhaustive];
}

const tagsOf = (patterns: readonly { readonly _tag: string }[]) => patterns.map((p) => p._tag);

describe("client error pattern groups", () => {
  it("WORKFLOW_START_PATTERNS names exactly the start-phase errors", () => {
    expect(tagsOf(WORKFLOW_START_PATTERNS)).toEqual([
      "@temporal-contract/WorkflowNotInContractError",
      "@temporal-contract/WorkflowValidationError",
      "@temporal-contract/WorkflowAlreadyStartedError",
    ]);
  });

  it("WORKFLOW_RESULT_PATTERNS names exactly the result-phase errors", () => {
    expect(tagsOf(WORKFLOW_RESULT_PATTERNS)).toEqual([
      "@temporal-contract/WorkflowValidationError",
      "@temporal-contract/WorkflowFailedError",
      "@temporal-contract/WorkflowCancelledError",
      "@temporal-contract/WorkflowTerminatedError",
      "@temporal-contract/WorkflowTimeoutError",
      "@temporal-contract/WorkflowExecutionNotFoundError",
    ]);
  });

  it("WORKFLOW_EXECUTE_PATTERNS is the union of both phases, without duplicates", () => {
    const tags = tagsOf(WORKFLOW_EXECUTE_PATTERNS);

    expect(new Set(tags)).toEqual(
      new Set([...tagsOf(WORKFLOW_START_PATTERNS), ...tagsOf(WORKFLOW_RESULT_PATTERNS)]),
    );
    expect(tags).toHaveLength(new Set(tags).size);
  });

  it("WORKFLOW_STOPPED_PATTERNS is the stopped trio, a subset of the result phase", () => {
    const stopped = tagsOf(WORKFLOW_STOPPED_PATTERNS);

    expect(stopped).toEqual([
      "@temporal-contract/WorkflowCancelledError",
      "@temporal-contract/WorkflowTerminatedError",
      "@temporal-contract/WorkflowTimeoutError",
    ]);
    expect(tagsOf(WORKFLOW_RESULT_PATTERNS)).toEqual(expect.arrayContaining(stopped));
  });

  it("SIGNAL_PATTERNS names exactly what a signal call produces", () => {
    expect(tagsOf(SIGNAL_PATTERNS)).toEqual([
      "@temporal-contract/SignalValidationError",
      "@temporal-contract/WorkflowExecutionNotFoundError",
    ]);
  });

  it("QUERY_PATTERNS names exactly what a query call produces", () => {
    expect(tagsOf(QUERY_PATTERNS)).toEqual([
      "@temporal-contract/QueryValidationError",
      "@temporal-contract/QueryFailedError",
      "@temporal-contract/WorkflowExecutionNotFoundError",
    ]);
  });

  it("UPDATE_PATTERNS names exactly what an update call produces", () => {
    expect(tagsOf(UPDATE_PATTERNS)).toEqual([
      "@temporal-contract/UpdateValidationError",
      "@temporal-contract/UpdateRejectedError",
      "@temporal-contract/UpdateFailedError",
      "@temporal-contract/WorkflowExecutionNotFoundError",
    ]);
  });

  it("SCHEDULE_CREATE_PATTERNS names exactly what schedule.create produces", () => {
    expect(tagsOf(SCHEDULE_CREATE_PATTERNS)).toEqual([
      "@temporal-contract/ScheduleAlreadyExistsError",
      "@temporal-contract/WorkflowNotInContractError",
      "@temporal-contract/WorkflowValidationError",
    ]);
  });
});
