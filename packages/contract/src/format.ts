/**
 * Standard Schema issue / validation-message formatters.
 *
 * Exposed from the contract package so client and worker share a single
 * source of truth for diagnostic rendering. Both used to carry their own
 * byte-identical copies and a comment promising the maintainers would
 * keep them in sync — that promise lives here now.
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
 *
 * Example output:
 * - `at items[0].quantity: Expected number, received undefined`
 * - `at customerId: Expected string, received undefined`
 * - `at user["first name"]: Expected string, received undefined`
 * - `Validation error` *(no path)*
 *
 * **The schema's message is included verbatim**, and schema libraries embed
 * the raw input in it (Valibot: `Invalid email: Received "jane@x"`). Use it
 * for in-process diagnostics only — never for text that crosses a Temporal
 * boundary; {@link summarizeIssues} is the redacted form for that.
 */
export function formatIssue(issue: StandardSchemaV1.Issue): string {
  if (issue.path === undefined || issue.path.length === 0) {
    return issue.message;
  }
  return `${formatIssuePath(issue)}: ${issue.message}`;
}

/** Maximum number of issue paths {@link summarizeIssues} lists before eliding the rest. */
const MAX_SUMMARIZED_ISSUES = 5;

/**
 * Join a list of validation issues into a single, **redacted** message: only
 * the failing paths, never the schema-provided message text, capped at the
 * first five issues — e.g. `at items[0].quantity; at customerId; …and 3 more`
 * (`at root` for an issue on the value itself).
 *
 * The summary becomes `ApplicationFailure.message` in Temporal history, which
 * payload codecs do not encrypt, and schema libraries embed raw input values
 * in their messages (Valibot: `Invalid email: Received "jane@x"`) — so the
 * messages are dropped and the length is bounded. The full issues stay
 * available, in process, on the error objects' `issues` property.
 */
export function summarizeIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): string {
  const listed = issues.slice(0, MAX_SUMMARIZED_ISSUES).map(formatIssuePath).join("; ");
  const rest = issues.length - MAX_SUMMARIZED_ISSUES;
  return rest > 0 ? `${listed}; …and ${rest} more` : listed;
}

/**
 * Render an issue's path as `at <path>`, or `at root` when it has none.
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
function formatIssuePath(issue: StandardSchemaV1.Issue): string {
  if (issue.path === undefined || issue.path.length === 0) {
    return "at root";
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
  return `at ${path}`;
}
