import { declareWorkflow, propagateActivityFailure } from "../workflow.js";
import { ROUTED_ACTIVITY_QUEUE, routingContract } from "./routing.contract.js";

/**
 * Workflow for the task-queue routing spec: `activityOptionsByName` routes
 * `reportQueue` to a dedicated queue (Temporal's full `ActivityOptions`
 * shape, so `taskQueue` works). The spec's activity worker is the ONLY
 * worker registering the activity implementation, and it polls only that
 * dedicated queue — so the workflow completing at all proves the override
 * actually routed the activity task there.
 */
export const routedFlow = declareWorkflow({
  workflowName: "routedFlow",
  contract: routingContract,
  // No workflow-wide `activityOptions`: the activity carries contract-level
  // options; the per-name override shallow-merges `taskQueue` on top.
  activityOptionsByName: {
    reportQueue: { taskQueue: ROUTED_ACTIVITY_QUEUE },
  },
  implementation: async (context) => {
    // The spec only ever exercises the success path (the dedicated activity
    // worker always resolves); a failure here would be an unmodeled routing
    // bug, so let Temporal decide the workflow's fate rather than folding it
    // into a returned status.
    const { handledBy } = await propagateActivityFailure(context.activities.reportQueue({}));
    return { handledBy };
  },
});
