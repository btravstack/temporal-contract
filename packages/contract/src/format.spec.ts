/**
 * Coverage for the shared Standard Schema issue formatters.
 *
 * `formatIssue` renders an issue's path with dot notation for identifier-safe
 * keys, `[N]` for numeric keys, JSON-quoted brackets for everything else, and
 * `[Symbol(...)]` for symbol keys. `summarizeIssues` joins the rendered
 * issues with `"; "`. Both consuming packages (`@temporal-contract/client`
 * and `@temporal-contract/worker`) rely on this rendering for their
 * validation error messages.
 */
import { describe, expect, it } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { formatIssue, summarizeIssues } from "./format.js";

function issue(
  message: string,
  path?: ReadonlyArray<PropertyKey | { key: PropertyKey }>,
): StandardSchemaV1.Issue {
  return path === undefined ? { message } : { message, path };
}

describe("formatIssue", () => {
  it("returns the bare message when the issue has no path", () => {
    expect(formatIssue(issue("Validation error"))).toBe("Validation error");
  });

  it("returns the bare message when the path is empty", () => {
    expect(formatIssue(issue("Validation error", []))).toBe("Validation error");
  });

  it("renders a single identifier-safe key without a leading dot", () => {
    expect(formatIssue(issue("Expected string", ["customerId"]))).toBe(
      "at customerId: Expected string",
    );
  });

  it("joins nested identifier-safe keys with dots", () => {
    expect(formatIssue(issue("Expected string", ["order", "customer", "name"]))).toBe(
      "at order.customer.name: Expected string",
    );
  });

  it("renders numeric keys as bracketed indices", () => {
    expect(formatIssue(issue("Expected number", ["items", 0, "quantity"]))).toBe(
      "at items[0].quantity: Expected number",
    );
  });

  it("normalizes `{ key: ... }` path segments per the spec", () => {
    expect(
      formatIssue(issue("Expected number", [{ key: "items" }, { key: 1 }, { key: "qty" }])),
    ).toBe("at items[1].qty: Expected number");
  });

  it("bracket-quotes keys that are not valid identifiers", () => {
    expect(formatIssue(issue("Expected string", ["user", "first name"]))).toBe(
      'at user["first name"]: Expected string',
    );
    expect(formatIssue(issue("Expected string", ["a.b", "0leading"]))).toBe(
      'at ["a.b"]["0leading"]: Expected string',
    );
  });

  it("bracket-quotes the empty string and numeric-looking string keys", () => {
    expect(formatIssue(issue("Expected string", [""]))).toBe('at [""]: Expected string');
    expect(formatIssue(issue("Expected string", ["items", "0"]))).toBe(
      'at items["0"]: Expected string',
    );
  });

  it("JSON-escapes embedded quotes in bracket-quoted keys", () => {
    expect(formatIssue(issue("Expected string", ['say "hi"']))).toBe(
      'at ["say \\"hi\\""]: Expected string',
    );
  });

  it("renders symbol keys via String(...)", () => {
    expect(formatIssue(issue("Expected string", ["user", Symbol("meta")]))).toBe(
      "at user[Symbol(meta)]: Expected string",
    );
  });
});

describe("summarizeIssues", () => {
  it("joins rendered issues with '; '", () => {
    expect(
      summarizeIssues([
        issue("Expected string", ["customerId"]),
        issue("Expected number", ["items", 0, "quantity"]),
        issue("Validation error"),
      ]),
    ).toBe(
      "at customerId: Expected string; at items[0].quantity: Expected number; Validation error",
    );
  });

  it("returns an empty string for an empty issue list", () => {
    expect(summarizeIssues([])).toBe("");
  });
});
