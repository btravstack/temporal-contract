/**
 * Issue / validation-message formatters.
 *
 * Lives in its own module (separate from `errors.ts` and `internal.ts`) so
 * both can import these helpers without forming a circular dependency:
 * `errors.ts` -> `format.ts` and `internal.ts` -> `format.ts` are both safe,
 * even when `internal.ts` later needs to import error classes from
 * `errors.ts` (as `createContinueAsNew` does).
 *
 * Not part of the package's public exports map.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Pattern for string keys safe to render with dot notation. A "safe" key is a
 * JavaScript identifier (letters/digits/underscore/$, not starting with a
 * digit). Anything else — keys containing dots, spaces, leading digits, the
 * empty string, the literal string `"0"` etc. — gets bracket-quoted so the
 * path is unambiguous. Reserved words are accepted: we are formatting a
 * diagnostic, not generating runnable code.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Render a Standard Schema {@link StandardSchemaV1.Issue} into a human-readable
 * string that includes the failing field's path.
 */
export function formatIssue(issue: StandardSchemaV1.Issue): string {
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
      path += `[${JSON.stringify(key)}]`;
    } else {
      path += `[${String(key)}]`;
    }
  }
  return `at ${path}: ${issue.message}`;
}

/**
 * Join a list of validation issues into a single message, with each issue
 * rendered via {@link formatIssue} so field paths surface in the error text.
 */
export function summarizeIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): string {
  return issues.map(formatIssue).join("; ");
}

/**
 * Build the message attached to a `ChildWorkflowError` for input/output
 * validation failures. Centralized so the worker and any future call sites
 * format identically.
 */
export function formatChildWorkflowValidationMessage(
  workflowName: string,
  direction: "input" | "output",
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): string {
  return `Child workflow "${workflowName}" ${direction} validation failed: ${summarizeIssues(issues)}`;
}
