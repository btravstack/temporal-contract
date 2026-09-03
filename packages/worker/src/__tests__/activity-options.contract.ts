import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

// Composition-first: resources defined individually, then composed.

const sleepInput = z.object({ sleepMs: z.number() });
const doneOutput = z.object({ done: z.boolean() });

/**
 * Deliberately tiny `startToCloseTimeout`. The workflow calls this activity
 * with an implementation that outlives the timeout, so a worker that failed
 * to apply the contract-level options would COMPLETE instead of timing out —
 * which is exactly the divergence the old mocked spec could not detect.
 */
const slowActivity = defineActivity({
  input: sleepInput,
  output: doneOutput,
  // An `errors` map (even empty) puts this activity on the AsyncResult path
  // (see `WorkflowInferActivity`), so the workflow can inspect `.isErr()` /
  // `.isDefect()` on the timeout instead of an uncaught throw failing the
  // whole workflow execution.
  errors: {},
  activityOptions: { startToCloseTimeout: "1 second", retry: { maximumAttempts: 1 } },
});

const runsActivity = defineWorkflow({
  input: sleepInput,
  output: z.object({ outcome: z.string() }),
  startPolicy: "allow-duplicate",
  activities: { slowActivity },
});

export const activityOptionsContract = defineContract({
  taskQueue: "activity-options-tests",
  workflows: { runsActivity },
});

/**
 * Second, independent contract: proves the merge-precedence layers
 * documented at `internal.ts:97-106` (workflow-wide default → contract-level
 * `activityOptions` → `activityOptionsByName` override), plus that the same
 * merge applies to a *global* contract activity, not just a workflow-local
 * one. Kept separate from `activityOptionsContract` so each test's
 * `declareActivitiesHandler` only has to implement the activities it
 * actually exercises.
 */

/**
 * Global (contract-level) activity — declared at the contract's root
 * `activities` map instead of nested under a workflow.
 * `buildRawActivitiesProxy` merges global + workflow-local definitions into
 * one flat namespace before applying the same layered-options logic to both,
 * so this activity is what proves that merge behaves identically for a
 * *global* activity.
 */
const globalTimeoutActivity = defineActivity({
  input: sleepInput,
  output: doneOutput,
  errors: {},
  activityOptions: { startToCloseTimeout: "1 second", retry: { maximumAttempts: 1 } },
});

/**
 * Contract-level `activityOptions` must win over `resolvesLayeredOptions`'s
 * (generous) workflow-wide default.
 */
const contractTimeoutActivity = defineActivity({
  input: sleepInput,
  output: doneOutput,
  errors: {},
  activityOptions: { startToCloseTimeout: "1 second", retry: { maximumAttempts: 1 } },
});

/**
 * No contract-level `activityOptions` at all — resolves purely from
 * `resolvesLayeredOptions`'s workflow-wide default. Completing (rather than
 * timing out) alongside `contractTimeoutActivity`'s timeout, in the *same*
 * workflow run, is what proves per-activity-name routing: the customized
 * proxy and the default proxy coexist and are addressed independently.
 */
const usesDefaultActivity = defineActivity({
  input: sleepInput,
  output: doneOutput,
  errors: {},
});

/**
 * Proves two of the five merge behaviors at once:
 *
 * - `activityOptionsByName` precedence over contract-level `activityOptions`
 *   — `resolvesLayeredOptions` overrides this activity's `retry` block via
 *   `activityOptionsByName`; if precedence were wrong (contract-level still
 *   won), the override would never take effect.
 * - Overrides shallow-merge, they don't deep-merge into the layer below —
 *   the contract-level `retry` here caps `maximumAttempts` at 1. The
 *   workflow's override (`activity-options.workflows.ts`) supplies its own
 *   `retry` block (`backoffCoefficient` + an explicit `maximumAttempts: 2`)
 *   rather than inheriting anything from this layer. If the merge were deep
 *   (field-by-field), the lower layer's `maximumAttempts: 1` would survive
 *   inside the merged `retry` and the activity would be allowed exactly one
 *   attempt — permanently failing, since the implementation only succeeds on
 *   the second call. Because the real merge is shallow, the override's
 *   `retry` object replaces the contract-level one *wholesale*: this
 *   layer's `maximumAttempts: 1` is gone, the override's own `2` applies
 *   instead, a second attempt happens, and the workflow completes.
 *
 *   Whether the time-skipping server also skips retry BACKOFF DELAY the same
 *   way it skips workflow timers is a claim this suite does not rely on —
 *   an earlier version of this comment asserted it from an informal, un-
 *   reproduced probe, which is not evidence this test's correctness should
 *   depend on. The explicit `maximumAttempts: 2` on the override makes that
 *   moot either way: retries are bounded regardless of backoff timing, so a
 *   merge-precedence regression fails the assertion instead of hanging the
 *   test to its timeout.
 */
const flakyActivity = defineActivity({
  input: z.object({}),
  output: z.object({ attempts: z.number() }),
  errors: {},
  activityOptions: { startToCloseTimeout: "5 seconds", retry: { maximumAttempts: 1 } },
});

const resolvesLayeredOptions = defineWorkflow({
  input: sleepInput,
  output: z.object({
    contractTimeout: z.string(),
    usesDefault: z.string(),
    flaky: z.string(),
    globalTimeout: z.string(),
  }),
  startPolicy: "allow-duplicate",
  activities: { contractTimeoutActivity, usesDefaultActivity, flakyActivity },
});

export const layeredOptionsContract = defineContract({
  taskQueue: "layered-activity-options-tests",
  activities: { globalTimeoutActivity },
  workflows: { resolvesLayeredOptions },
});
