/**
 * Bound rules for activity options, split out of `internal.ts` so they are
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
import type { ActivityOptions } from "@temporalio/workflow";

/** Which of the two bounds an activity is missing. */
export type BoundKind = "per-attempt" | "total";

/** One activity that fails the bound rules, and which bounds it lacks. */
export type BoundViolation = {
  readonly name: string;
  readonly missing: readonly BoundKind[];
};

/**
 * True when the options cap a single attempt. `scheduleToCloseTimeout` counts:
 * it caps the whole sequence, so it necessarily caps one attempt.
 */
export function hasPerAttemptBound(options: ActivityOptions): boolean {
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
export function hasTotalBound(options: ActivityOptions): boolean {
  if (options.scheduleToCloseTimeout !== undefined) return true;
  const maximumAttempts = options.retry?.maximumAttempts;
  return (
    typeof maximumAttempts === "number" && Number.isInteger(maximumAttempts) && maximumAttempts > 0
  );
}

/** The bounds these options lack, in a stable order. Empty means compliant. */
export function missingBounds(options: ActivityOptions): BoundKind[] {
  const missing: BoundKind[] = [];
  if (!hasPerAttemptBound(options)) missing.push("per-attempt");
  if (!hasTotalBound(options)) missing.push("total");
  return missing;
}

const REMEDY: Record<BoundKind, string> = {
  "per-attempt":
    "missing a per-attempt bound (set `startToCloseTimeout` or `scheduleToCloseTimeout`)",
  total:
    "missing a total bound (set `scheduleToCloseTimeout`, or a finite positive `retry.maximumAttempts`)",
};

/**
 * The `ContractMisuseError` message. Names every offender and the remedy for
 * each rule it broke, then explains the non-obvious cause: because the three
 * option layers shallow-merge, a later layer's `retry` replaces an earlier
 * layer's entirely, so two individually-bounded layers can merge to something
 * unbounded.
 */
export function formatUnboundedActivitiesMessage(violations: readonly BoundViolation[]): string {
  const lines = violations.map(
    ({ name, missing }) => `  - ${name}: ${missing.map((kind) => REMEDY[kind]).join(", ")}`,
  );

  // Determine which bounds are actually missing across all violations
  const allMissingBounds = new Set<BoundKind>();
  for (const violation of violations) {
    for (const kind of violation.missing) {
      allMissingBounds.add(kind);
    }
  }

  // Build introduction based on what's actually missing
  const boundsPhrase =
    allMissingBounds.size === 2
      ? "a per-attempt bound and a total bound"
      : allMissingBounds.has("per-attempt")
        ? "a per-attempt bound"
        : "a total bound";

  return (
    `declareWorkflow: every reachable activity needs ${boundsPhrase}, ` +
    `so a failing activity cannot retry forever. These do not:\n${lines.join("\n")}\n` +
    `Options are merged from \`declareWorkflow\`'s \`activityOptions\`, the contract's ` +
    `\`defineActivity({ activityOptions })\`, and \`activityOptionsByName\`. That merge is ` +
    `shallow, so a later layer's \`retry\` replaces an earlier layer's entirely — check the ` +
    `merged result, not each layer.`
  );
}
