import { propagateActivityFailure } from "../activity-failure.js";
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
    // `reportsTimeouts` declares no contract `errors`, but every activity
    // call is uniformly `AsyncResult`-shaped now regardless of a declared
    // `errors` map. The spec only exercises the success path (each merge
    // layer contributing its value), so let a technical failure escape via
    // propagateActivityFailure and have Temporal decide the workflow's fate.
    return await propagateActivityFailure(context.activities.reportsTimeouts({}));
  },
});
