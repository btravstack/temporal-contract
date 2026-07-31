import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

// Composition-first: resources defined individually, then composed.

/**
 * Deliberately tiny `startToCloseTimeout`. The workflow calls this activity
 * with an implementation that outlives the timeout, so a worker that failed
 * to apply the contract-level options would COMPLETE instead of timing out —
 * which is exactly the divergence the old mocked spec could not detect.
 */
const slowActivity = defineActivity({
  input: z.object({ sleepMs: z.number() }),
  output: z.object({ done: z.boolean() }),
  // An `errors` map (even empty) puts this activity on the AsyncResult path
  // (see `WorkflowInferActivity`), so the workflow can inspect `.isErr()` /
  // `.isDefect()` on the timeout instead of an uncaught throw failing the
  // whole workflow execution.
  errors: {},
  activityOptions: { startToCloseTimeout: "1 second", retry: { maximumAttempts: 1 } },
});

const runsActivity = defineWorkflow({
  input: z.object({ sleepMs: z.number() }),
  output: z.object({ outcome: z.string() }),
  activities: { slowActivity },
});

export const activityOptionsContract = defineContract({
  taskQueue: "activity-options-tests",
  workflows: { runsActivity },
});
