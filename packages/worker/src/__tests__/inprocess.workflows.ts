import { condition, sleep } from "@temporalio/workflow";

import { ContractError, declareWorkflow, rethrowCancellation } from "../workflow.js";
import { inprocessContract } from "./inprocess.contract.js";

export const placeOrder = declareWorkflow({
  workflowName: "placeOrder",
  contract: inprocessContract,
  // No `activityOptions`: the only reachable activity (`charge`) carries
  // contract-level `activityOptions`.
  implementation: async (context, args) => {
    if (args.amount === 0) {
      // Typed workflow error — rehydrated as a ContractError by the client.
      throw context.errors.EmptyOrder({ orderId: args.orderId });
    }

    // Time-skipping proof: an hour-long timer must resolve immediately under
    // the TestWorkflowEnvironment.
    await sleep("1 hour");

    const charged = await context.activities.charge({ amount: args.amount });
    if (charged.isDefect()) {
      // An unmodeled bug — rethrow the original cause at the edge.
      throw charged.cause;
    }
    if (charged.isErr()) {
      if (charged.error instanceof ContractError && charged.error.errorName === "PaymentDeclined") {
        // Typed activity error — rehydrated on the workflow side.
        return { status: `declined:${charged.error.data.reason}` };
      }
      return { status: "failed" };
    }

    return { status: `charged:${charged.value.transactionId}` };
  },
});

export const waitForever = declareWorkflow({
  workflowName: "waitForever",
  contract: inprocessContract,
  implementation: async (context, _args) => {
    // Block until cancelled: `condition(() => false)` never resolves on its
    // own (even under time skipping), so the only way out of the scope is a
    // cancellation request.
    const result = await context.cancellableScope(async () => {
      await condition(() => false);
      return "unreachable";
    });

    if (result.isDefect()) {
      // An unmodeled bug — rethrow the original cause at the edge.
      // oxlint-disable-next-line unthrown/no-throw -- defect-cause rethrow at the edge: an unmodeled failure must surface as a Workflow Task failure
      throw result.cause;
    }
    if (result.isErr()) {
      // Honor the cancellation: without this re-raise the workflow would
      // return normally and end `Completed` instead of `Cancelled`.
      rethrowCancellation(result.error);
    }

    return { status: "completed" };
  },
});
