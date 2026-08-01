import { TimeoutFailure } from "@temporalio/common";

import { declareWorkflow } from "../workflow.js";
import { activityOptionsContract, layeredOptionsContract } from "./activity-options.contract.js";

/**
 * Folds an `Err`-shaped activity-call result into an outcome string that
 * distinguishes a real start-to-close timeout from any other failure
 * (input/output validation, activity-not-registered, ...). `ActivityError`
 * has no contract `.type` (that only exists on rehydrated typed errors);
 * `.cause` is the unwrapped actionable Temporal failure, so narrowing it to
 * `TimeoutFailure` is what lets the outcome say *why* it failed.
 */
function timeoutAwareOutcome(result: { cause?: unknown; name: string }): string {
  const timeoutType = result.cause instanceof TimeoutFailure ? result.cause.timeoutType : undefined;
  return `err:${timeoutType ?? result.name}`;
}

export const runsActivity = declareWorkflow({
  workflowName: "runsActivity",
  contract: activityOptionsContract,
  // No `activityOptions` here — the contract-level options must be what
  // reaches Temporal. That is the property under test.
  implementation: async (context, args) => {
    const result = await context.activities.slowActivity({ sleepMs: args.sleepMs });

    if (result.isDefect()) throw result.cause;
    // A weaker assertion (e.g. "outcome contains err:") would also pass for
    // an input/output validation failure or an unregistered activity — none
    // of which prove the timeout fired. `timeoutAwareOutcome` narrows to the
    // real cause so the test can assert the exact reason.
    if (result.isErr()) return { outcome: timeoutAwareOutcome(result.error) };
    return { outcome: "completed" };
  },
});

export const resolvesLayeredOptions = declareWorkflow({
  workflowName: "resolvesLayeredOptions",
  contract: layeredOptionsContract,
  // Generous workflow-wide default — every proof below relies on some
  // activity's more specific options (contract-level or override) winning
  // over this default, not the other way around.
  activityOptions: { startToCloseTimeout: "30 seconds", retry: { maximumAttempts: 1 } },
  // `flakyActivity`'s contract-level `activityOptions` caps retries at 1
  // attempt. This override replaces that `retry` block wholesale (shallow
  // merge — it does not carry the lower layer's `maximumAttempts: 1`
  // forward); see the doc comment on `flakyActivity` in the contract for the
  // full argument. The override supplies its OWN `maximumAttempts: 2` rather
  // than leaving it unset: `flakyActivity`'s implementation fails once then
  // succeeds, so 2 attempts is exactly what the happy path needs, and capping
  // it (instead of falling through to Temporal's unbounded default) turns a
  // merge-precedence regression that broke the "succeeds on retry" path into
  // a fast assertion failure instead of a 120s test-timeout hang.
  activityOptionsByName: {
    flakyActivity: { retry: { backoffCoefficient: 1, maximumAttempts: 2 } },
  },
  implementation: async (context, args) => {
    const [contractTimeout, usesDefault, flaky, globalTimeout] = await Promise.all([
      context.activities.contractTimeoutActivity({ sleepMs: args.sleepMs }),
      context.activities.usesDefaultActivity({ sleepMs: args.sleepMs }),
      context.activities.flakyActivity({}),
      context.activities.globalTimeoutActivity({ sleepMs: args.sleepMs }),
    ]);

    const outcomeOf = (result: typeof contractTimeout | typeof globalTimeout): string => {
      if (result.isDefect()) throw result.cause;
      if (result.isErr()) return timeoutAwareOutcome(result.error);
      return "completed";
    };

    return {
      contractTimeout: outcomeOf(contractTimeout),
      usesDefault: outcomeOf(usesDefault),
      flaky: flaky.isDefect() ? "defect" : flaky.isErr() ? `err:${flaky.error.name}` : "completed",
      globalTimeout: outcomeOf(globalTimeout),
    };
  },
});
