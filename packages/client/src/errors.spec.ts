/**
 * Coverage for the path-aware issue formatting in client validation errors,
 * plus the `WorkflowFailedError.cause` typing contract.
 *
 * Mirrors the worker-side test (#141 closes both surfaces); the helpers are
 * intentionally duplicated across packages so each entry point has its own
 * formatting source of truth.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  ActivityFailure,
  ApplicationFailure,
  CancelledFailure,
  ChildWorkflowFailure,
  ServerFailure,
  TerminatedFailure,
  TimeoutFailure,
} from "@temporalio/common";
import {
  QueryValidationError,
  SignalValidationError,
  type TemporalFailure,
  UpdateValidationError,
  WorkflowFailedError,
  WorkflowValidationError,
} from "./errors.js";

const issue = (
  message: string,
  path?: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment>,
): StandardSchemaV1.Issue => (path === undefined ? { message } : { message, path });

describe("validation error message formatting", () => {
  it("WorkflowValidationError includes the field path", () => {
    const error = new WorkflowValidationError("processOrder", "input", [
      issue("expected string", ["customerId"]),
    ]);
    expect(error.message).toBe(
      `Validation failed for workflow "processOrder" input: at customerId: expected string`,
    );
  });

  it("QueryValidationError includes nested path with array indices", () => {
    const error = new QueryValidationError("getOrderItems", "output", [
      issue("expected number", ["items", 3, "quantity"]),
    ]);
    expect(error.message).toBe(
      `Validation failed for query "getOrderItems" output: at items[3].quantity: expected number`,
    );
  });

  it("SignalValidationError joins multiple issues with their paths", () => {
    const error = new SignalValidationError("updateProgress", [
      issue("expected number", ["progress"]),
      issue("expected string", ["userId"]),
    ]);
    expect(error.message).toBe(
      `Validation failed for signal "updateProgress": at progress: expected number; at userId: expected string`,
    );
  });

  it("UpdateValidationError unwraps PathSegment-form entries", () => {
    const error = new UpdateValidationError("setConfig", "input", [
      issue("expected boolean", [{ key: "config" }, { key: "enabled" }]),
    ]);
    expect(error.message).toBe(
      `Validation failed for update "setConfig" input: at config.enabled: expected boolean`,
    );
  });

  it("falls back to just the message when no path is present", () => {
    const error = new WorkflowValidationError("processOrder", "input", [issue("invalid input")]);
    expect(error.message).toBe(
      `Validation failed for workflow "processOrder" input: invalid input`,
    );
  });

  it("preserves the typed `issues` property for programmatic access", () => {
    const issues = [issue("expected string", ["customerId"])];
    const error = new WorkflowValidationError("processOrder", "input", issues);
    expect(error.issues).toEqual(issues);
    expect(error.workflowName).toBe("processOrder");
    expect(error.direction).toBe("input");
  });

  describe("non-identifier and symbol path segments", () => {
    // The client keeps its own copy of the formatter (intentional, per
    // package boundaries), so these edge cases need their own coverage —
    // the worker-side tests can't catch regressions here.

    it("bracket-quotes string keys that aren't valid JS identifiers", () => {
      const error = new WorkflowValidationError("processOrder", "input", [
        issue("invalid", ["foo.bar"]),
      ]);
      expect(error.message).toBe(
        `Validation failed for workflow "processOrder" input: at ["foo.bar"]: invalid`,
      );
    });

    it("bracket-quotes the empty-string key", () => {
      const error = new WorkflowValidationError("processOrder", "input", [issue("invalid", [""])]);
      expect(error.message).toBe(
        `Validation failed for workflow "processOrder" input: at [""]: invalid`,
      );
    });

    it('disambiguates the literal string "0" from the numeric index 0', () => {
      const stringKey = new WorkflowValidationError("processOrder", "input", [
        issue("invalid", ["0"]),
      ]);
      const numericKey = new WorkflowValidationError("processOrder", "input", [
        issue("invalid", [0]),
      ]);
      expect(stringKey.message).toBe(
        `Validation failed for workflow "processOrder" input: at ["0"]: invalid`,
      );
      expect(numericKey.message).toBe(
        `Validation failed for workflow "processOrder" input: at [0]: invalid`,
      );
    });

    it("falls back to bracket-stringification for symbol path segments", () => {
      const symbolKey = Symbol("hidden");
      const error = new WorkflowValidationError("processOrder", "input", [
        issue("invalid", [symbolKey]),
      ]);
      expect(error.message).toBe(
        `Validation failed for workflow "processOrder" input: at [Symbol(hidden)]: invalid`,
      );
    });
  });
});

describe("WorkflowFailedError.cause typing", () => {
  // These assertions are purely structural: `expectTypeOf` is a no-op at
  // runtime — the type-checker is what fails the build if `cause` ever
  // widens back to `unknown`. The point of locking this down is that
  // consumers should be able to write `if (err.cause instanceof
  // ApplicationFailure)` without a preceding `instanceof Error` narrow,
  // and exhaustive `switch (true)` over the leaf failure types should
  // type-check without a fallback case.

  it("types `cause` as the TemporalFailure union, optional", () => {
    expectTypeOf<WorkflowFailedError["cause"]>().toEqualTypeOf<TemporalFailure | undefined>();
  });

  it("`TemporalFailure` enumerates the leaf Temporal failure classes", () => {
    expectTypeOf<TemporalFailure>().toEqualTypeOf<
      | ApplicationFailure
      | CancelledFailure
      | TerminatedFailure
      | TimeoutFailure
      | ChildWorkflowFailure
      | ServerFailure
      | ActivityFailure
    >();
  });

  it("does not widen to `unknown` (regression: PR2 of error refactor series)", () => {
    // Negative assertion — would fail if the field reverted to `unknown`.
    expectTypeOf<WorkflowFailedError["cause"]>().not.toBeUnknown();
  });
});
