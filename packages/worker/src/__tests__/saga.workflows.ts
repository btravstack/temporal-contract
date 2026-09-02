import { declareWorkflow } from "../workflow.js";
import { sagaContract } from "./saga.contract.js";

/**
 * The saga runs inside the real workflow sandbox here, which is what this
 * fixture exists to prove: `@unthrown/saga` reaches the bundle, and the
 * policy decides the walk-back on the failure Temporal actually delivered.
 */
export const fulfil = declareWorkflow({
  workflowName: "fulfil",
  contract: sagaContract,
  activityOptions: { startToCloseTimeout: "10 seconds" },
  implementation: async (context, { mode }) => {
    const settled = await context
      .saga()
      .step(
        () => context.activities.reserve({}),
        () => context.activities.release({}),
      )
      .step(
        () => context.activities.charge({}),
        () => context.activities.refund({}),
      )
      .step(() => context.activities.ship({ mode }))
      .run();

    // The failure comes back unchanged, so its tag is what the caller would
    // have triaged without the saga.
    return { failedWith: settled.isErr() ? settled.error._tag : "no failure" };
  },
});
