/**
 * Bound rules for activity options, shared by the worker (`declareWorkflow`,
 * `context.executeActivity`) and the client (standalone activities), and
 * unit-testable without a workflow sandbox or a Temporal server.
 *
 * Two independent bounds must hold for every reachable activity:
 *
 * - **per-attempt** — how long ONE attempt may run.
 * - **total** — how long the whole retry sequence may run.
 *
 * They are genuinely independent. `startToCloseTimeout` caps a single attempt
 * and says nothing about the sequence, while `RetryPolicy.maximumAttempts`
 * defaults to `Infinity` (`@temporalio/common/lib/retry-policy.d.ts:21-26`).
 * An activity with only `startToCloseTimeout` therefore retries a
 * non-transient failure roughly every 100 seconds, forever.
 */
import type { ActivityRetryPolicy } from "./types.js";

/**
 * The slice of Temporal's `ActivityOptions` the bound rules read — kept
 * structural so this package stays free of `@temporalio/*` dependencies.
 */
export type BoundedOptions = {
  readonly startToCloseTimeout?: unknown;
  readonly scheduleToCloseTimeout?: unknown;
  readonly retry?: ActivityRetryPolicy | undefined;
};

/** Which of the two bounds an activity is missing. */
export type BoundKind = "per-attempt" | "total";

/**
 * True when the options cap a single attempt. `scheduleToCloseTimeout` counts:
 * it caps the whole sequence, so it necessarily caps one attempt.
 */
export function hasPerAttemptBound(options: BoundedOptions): boolean {
  return options.startToCloseTimeout !== undefined || options.scheduleToCloseTimeout !== undefined;
}

/**
 * True when the options cap the whole retry sequence.
 *
 * `maximumAttempts` is a bound only when it is a finite positive integer:
 * Temporal deletes the field when it is `Infinity` because that IS the default
 * (`retry-policy.js:15-18`), and rejects `<= 0` and non-integers with a
 * `ValueError` in `compileRetryPolicy`. Stating the rule positively means an
 * unbounded value produces this library's message, while a genuinely invalid
 * value still reaches Temporal's own validation.
 */
export function hasTotalBound(options: BoundedOptions): boolean {
  if (options.scheduleToCloseTimeout !== undefined) return true;
  const maximumAttempts = options.retry?.maximumAttempts;
  return (
    typeof maximumAttempts === "number" && Number.isInteger(maximumAttempts) && maximumAttempts > 0
  );
}

/** The bounds these options lack, in a stable order. Empty means compliant. */
export function missingBounds(options: BoundedOptions): BoundKind[] {
  const missing: BoundKind[] = [];
  if (!hasPerAttemptBound(options)) missing.push("per-attempt");
  if (!hasTotalBound(options)) missing.push("total");
  return missing;
}
