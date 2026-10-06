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

export const shipChild = declareWorkflow({
  workflowName: "shipChild",
  contract: sagaContract,
  // Never calls one, but the global activities are reachable, so bounded.
  activityOptions: { startToCloseTimeout: "10 seconds" },
  implementation: async (context, { sku }) => {
    throw context.errors.OutOfStock({ sku });
  },
});

/**
 * Step two is a child workflow that fails with its own declared error. The
 * parent must receive it rehydrated as a `ContractError`, which is what makes
 * the saga undo step one.
 */
export const fulfilViaChild = declareWorkflow({
  workflowName: "fulfilViaChild",
  contract: sagaContract,
  activityOptions: { startToCloseTimeout: "10 seconds" },
  implementation: async (context) => {
    // Route the child to this run's (per-test) task queue.
    const contract = { ...sagaContract, taskQueue: context.info.taskQueue };
    let childWorkflowId = "";
    const settled = await context
      .saga()
      .step(
        () => context.activities.reserve({}),
        () => context.activities.release({}),
      )
      .step(() =>
        context
          .startChildWorkflow(contract, "shipChild", {
            args: { sku: "s-1" },
            parentClosePolicy: "TERMINATE",
          })
          .flatMap((handle) => {
            childWorkflowId = handle.workflowId;
            return handle.result();
          }),
      )
      .run();

    return { failedWith: settled.isErr() ? settled.error._tag : "no failure", childWorkflowId };
  },
});
