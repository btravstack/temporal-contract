/**
 * Coverage for the path-aware issue formatting in worker validation errors
 * and in `formatChildWorkflowValidationMessage` (the workflow.ts call site
 * for child-workflow input/output validation).
 *
 * The error classes are simple constructors; what we care about is that the
 * resulting `error.message` includes the failing field's path so debugging
 * a contract validation failure isn't a guessing game.
 *
 * Closes #141.
 */
import { describe, expect, it } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  ActivityInputValidationError,
  ActivityOutputValidationError,
  WorkflowInputValidationError,
} from "./errors.js";
import { formatChildWorkflowValidationMessage } from "./internal.js";

const issue = (
  message: string,
  path?: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment>,
): StandardSchemaV1.Issue => (path === undefined ? { message } : { message, path });

describe("validation error message formatting", () => {
  it("falls back to just the message when no path is present", () => {
    const error = new ActivityInputValidationError("act", [issue("invalid input")]);
    expect(error.message).toBe(`Activity "act" input validation failed: invalid input`);
  });

  it("renders a top-level string key with no prefix", () => {
    const error = new ActivityInputValidationError("act", [
      issue("expected string", ["customerId"]),
    ]);
    expect(error.message).toBe(
      `Activity "act" input validation failed: at customerId: expected string`,
    );
  });

  it("renders nested object paths with dot notation", () => {
    const error = new ActivityInputValidationError("act", [
      issue("expected number", ["payment", "amount"]),
    ]);
    expect(error.message).toBe(
      `Activity "act" input validation failed: at payment.amount: expected number`,
    );
  });

  it("renders array indices with bracket notation", () => {
    const error = new ActivityInputValidationError("act", [issue("expected object", ["items", 0])]);
    expect(error.message).toBe(
      `Activity "act" input validation failed: at items[0]: expected object`,
    );
  });

  it("renders mixed object/array paths", () => {
    const error = new ActivityInputValidationError("act", [
      issue("expected number", ["items", 2, "quantity"]),
    ]);
    expect(error.message).toBe(
      `Activity "act" input validation failed: at items[2].quantity: expected number`,
    );
  });

  it("unwraps PathSegment-form path entries (Standard Schema spec)", () => {
    // Per the spec, paths can be `ReadonlyArray<PropertyKey | PathSegment>`.
    // PathSegment objects expose the underlying key via `.key`.
    const error = new ActivityInputValidationError("act", [
      issue("expected boolean", [{ key: "items" }, { key: 0 }, { key: "active" }]),
    ]);
    expect(error.message).toBe(
      `Activity "act" input validation failed: at items[0].active: expected boolean`,
    );
  });

  it("falls back to bracket-stringification for symbol path segments", () => {
    const symbolKey = Symbol("hidden");
    const error = new ActivityInputValidationError("act", [issue("invalid", [symbolKey])]);
    expect(error.message).toBe(
      `Activity "act" input validation failed: at [Symbol(hidden)]: invalid`,
    );
  });

  it("joins multiple issues with `; ` and applies path formatting to each", () => {
    const error = new ActivityInputValidationError("act", [
      issue("expected array, received undefined", ["items"]),
      issue("expected number, received undefined", ["items", 0, "quantity"]),
    ]);
    // Reproduces the issue's example output, with paths now visible.
    expect(error.message).toBe(
      `Activity "act" input validation failed: ` +
        `at items: expected array, received undefined; ` +
        `at items[0].quantity: expected number, received undefined`,
    );
  });

  it("applies path formatting on the output side too", () => {
    const error = new ActivityOutputValidationError("act", [
      issue("expected string", ["transactionId"]),
    ]);
    expect(error.message).toContain(`at transactionId: expected string`);
  });

  it("applies to workflow validation errors as well", () => {
    const error = new WorkflowInputValidationError("processOrder", [
      issue("expected number", ["totalAmount"]),
    ]);
    expect(error.message).toBe(
      `Workflow "processOrder" input validation failed: at totalAmount: expected number`,
    );
  });

  it("preserves the typed `issues` property for programmatic access", () => {
    const issues = [issue("expected string", ["customerId"])];
    const error = new ActivityInputValidationError("act", issues);
    expect(error.issues).toEqual(issues);
    expect(error.activityName).toBe("act");
  });

  describe("non-identifier string keys", () => {
    // Standard Schema paths can carry arbitrary string property keys. Naively
    // dot-joining produces wrong field names for keys like "foo.bar",
    // "first name", "" or "0" — bracket-quote them so the path is unambiguous.

    it("bracket-quotes keys containing dots", () => {
      const error = new ActivityInputValidationError("act", [issue("invalid", ["foo.bar"])]);
      expect(error.message).toBe(`Activity "act" input validation failed: at ["foo.bar"]: invalid`);
    });

    it("bracket-quotes keys containing whitespace", () => {
      const error = new ActivityInputValidationError("act", [
        issue("expected string", ["user", "first name"]),
      ]);
      expect(error.message).toBe(
        `Activity "act" input validation failed: at user["first name"]: expected string`,
      );
    });

    it("bracket-quotes keys starting with a digit", () => {
      const error = new ActivityInputValidationError("act", [issue("invalid", ["123foo"])]);
      expect(error.message).toBe(`Activity "act" input validation failed: at ["123foo"]: invalid`);
    });

    it("bracket-quotes the empty-string key", () => {
      const error = new ActivityInputValidationError("act", [issue("invalid", [""])]);
      expect(error.message).toBe(`Activity "act" input validation failed: at [""]: invalid`);
    });

    it('disambiguates the literal string key "0" from the numeric index 0', () => {
      const stringKey = new ActivityInputValidationError("act", [issue("invalid", ["0"])]);
      const numericKey = new ActivityInputValidationError("act", [issue("invalid", [0])]);
      expect(stringKey.message).toBe(`Activity "act" input validation failed: at ["0"]: invalid`);
      expect(numericKey.message).toBe(`Activity "act" input validation failed: at [0]: invalid`);
    });

    it("escapes embedded quotes via JSON.stringify", () => {
      const error = new ActivityInputValidationError("act", [issue("invalid", [`with"quote`])]);
      expect(error.message).toBe(
        `Activity "act" input validation failed: at ["with\\"quote"]: invalid`,
      );
    });
  });

  describe("formatChildWorkflowValidationMessage", () => {
    // The workflow.ts call sites for child-workflow input/output validation
    // delegate to this helper. Path-aware behavior would otherwise be
    // unexercised at the unit level — only covered indirectly via the
    // worker error classes, which use the same `summarizeIssues` underneath.

    it("formats input validation failures with field paths", () => {
      const message = formatChildWorkflowValidationMessage("processChild", "input", [
        issue("expected number", ["amount"]),
      ]);
      expect(message).toBe(
        `Child workflow "processChild" input validation failed: at amount: expected number`,
      );
    });

    it("formats output validation failures and joins multiple issues", () => {
      const message = formatChildWorkflowValidationMessage("processChild", "output", [
        issue("expected boolean", ["success"]),
        issue("expected string", ["transactionId"]),
      ]);
      expect(message).toBe(
        `Child workflow "processChild" output validation failed: at success: expected boolean; at transactionId: expected string`,
      );
    });

    it("falls back to just the message when no path is present", () => {
      const message = formatChildWorkflowValidationMessage("processChild", "input", [
        issue("invalid input"),
      ]);
      expect(message).toBe(`Child workflow "processChild" input validation failed: invalid input`);
    });
  });
});
