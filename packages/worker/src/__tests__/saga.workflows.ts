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
        () => context.activities.charge({ sleepMs: 50 }),
        () => context.activities.refund({}),
      )
      .step(() => context.activities.ship({ mode }))
      .run();

    // The failure comes back unchanged, so its tag is what the caller would
    // have triaged without the saga.
    return { failedWith: settled.isErr() ? settled.error._tag : "no failure" };
  },
});

/**
 * Step two is cancelled in flight. With `compensateOnCancellation`, step one's
 * undo has to run anyway — and it is an activity call, so it only runs at all
 * because the walk-back enters a non-cancellable scope.
 */
export const fulfilUntilCancelled = declareWorkflow({
  workflowName: "fulfilUntilCancelled",
  contract: sagaContract,
  activityOptions: { startToCloseTimeout: "10 seconds" },
  implementation: async (context) => {
    const settled = await context
      .saga({ compensateOnCancellation: true })
      .step(
        () => context.activities.reserve({}),
        () => context.activities.release({}),
      )
      .step(() => context.activities.charge({ sleepMs: 30_000 }))
      .run();

    return { failedWith: settled.isErr() ? settled.error._tag : "no failure" };
  },
});
