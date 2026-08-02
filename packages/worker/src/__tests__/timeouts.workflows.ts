import { declareWorkflow } from "../workflow.js";
import { timeoutsContract } from "./timeouts.contract.js";

export const reportsLayered = declareWorkflow({
  workflowName: "reportsLayered",
  contract: timeoutsContract,
  // Workflow-wide layer.
  activityOptions: { scheduleToCloseTimeout: "20 seconds" },
  // Per-activity layer — contributes startToClose. The three keys asserted
  // in timeouts.inprocess.spec.ts are disjoint across all three layers, so
  // this fixture proves each layer's value reaches Temporal (forwarding),
  // not precedence between layers — that's covered separately by
  // activity-options.contract.ts.
  activityOptionsByName: { reportsTimeouts: { startToCloseTimeout: "9 seconds" } },
  implementation: async (context) => {
    // `reportsTimeouts` declares no contract `errors`, so the workflow-side
    // proxy is the plain-throwing wrapper (matching Temporal's native
    // behavior) rather than an AsyncResult — there is no `.isErr()`/
    // `.isDefect()` to narrow here.
    return await context.activities.reportsTimeouts({});
  },
});
