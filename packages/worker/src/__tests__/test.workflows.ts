import { sleep } from "@temporalio/workflow";

import { propagateActivityFailure } from "../activity-failure.js";
import { declareWorkflow } from "../workflow.js";
import { testContract } from "./test.contract.js";

export const simpleWorkflow = declareWorkflow({
  workflowName: "simpleWorkflow",
  contract: testContract,
  implementation: async ({ activities }, args) => {
    await propagateActivityFailure(activities.logMessage({ message: `Processing: ${args.value}` }));
    return {
      result: `Processed: ${args.value}`,
    };
  },
  activityOptions: {
    startToCloseTimeout: "1 minute",
  },
});

export const workflowWithActivities = declareWorkflow({
  workflowName: "workflowWithActivities",
  contract: testContract,
  // Demonstrates `activityOptionsByName`: most activities use the workflow
  // default, but `processPayment` is given a longer timeout because the
  // (real) gateway is slower than typical activities.
  activityOptionsByName: {
    processPayment: {
      startToCloseTimeout: "5 minutes",
      retry: { maximumAttempts: 5 },
    },
  },
  implementation: async ({ activities }, args) => {
    // Both activities below always succeed technically in this fixture's
    // tests — `valid`/`success` are business outcomes carried in the Ok
    // value, not activity failures. A *technical* failure here (neither
    // test exercises one) should still fail the workflow rather than being
    // folded into the "failed" business status, so unwrap with
    // propagateActivityFailure and only branch on the business fields.

    // Validate order
    const validationResult = await propagateActivityFailure(
      activities.validateOrder({ orderId: args.orderId }),
    );

    if (!validationResult.valid) {
      return {
        orderId: args.orderId,
        status: "failed" as const,
        reason: "Invalid order ID",
      };
    }

    // Process payment
    const paymentResult = await propagateActivityFailure(
      activities.processPayment({ amount: args.amount }),
    );

    if (!paymentResult.success) {
      return {
        orderId: args.orderId,
        status: "failed" as const,
        reason: "Payment failed",
      };
    }

    // Log success
    await propagateActivityFailure(
      activities.logMessage({
        message: `Order ${args.orderId} completed with transaction ${paymentResult.transactionId}`,
      }),
    );

    return {
      orderId: args.orderId,
      status: "success" as const,
      transactionId: paymentResult.transactionId,
    };
  },
  activityOptions: {
    startToCloseTimeout: "1 minute",
  },
});

export const interactiveWorkflow = declareWorkflow({
  workflowName: "interactiveWorkflow",
  contract: testContract,
  implementation: async ({ handleSignal, handleQuery, handleUpdate }, args) => {
    let currentValue = 0;

    currentValue = args.initialValue;

    // Bind signal, query, and update handlers with access to workflow state
    handleSignal("increment", async (signalArgs) => {
      currentValue += signalArgs.amount;
    });

    handleQuery("getCurrentValue", () => {
      return { value: currentValue };
    });

    handleUpdate("multiply", async (updateArgs) => {
      currentValue *= updateArgs.factor;
      return { newValue: currentValue };
    });

    // Simulate some processing time to allow signals/queries/updates
    await sleep(100);

    return {
      finalValue: currentValue,
    };
  },
  activityOptions: {
    startToCloseTimeout: "1 minute",
  },
});

// Parent workflow that starts child workflows
export const parentWorkflow = declareWorkflow({
  workflowName: "parentWorkflow",
  contract: testContract,
  implementation: async ({ executeChildWorkflow }, args) => {
    const results: string[] = [];

    for (let i = 0; i < args.count; i++) {
      const childResult = await executeChildWorkflow(testContract, "childWorkflow", {
        workflowId: `child-${i}`,
        args: { id: i },
      });

      if (childResult.isOk()) {
        results.push(childResult.value.message);
      } else if (childResult.isErr()) {
        results.push(`Error: ${childResult.error.message}`);
      } else {
        results.push(`Defect: ${String(childResult.cause)}`);
      }
    }

    return { results };
  },
  activityOptions: {
    startToCloseTimeout: "1 minute",
  },
});

// Child workflow
export const childWorkflow = declareWorkflow({
  workflowName: "childWorkflow",
  contract: testContract,
  implementation: async ({ activities }, args) => {
    await propagateActivityFailure(
      activities.logMessage({ message: `Child workflow ${args.id} running` }),
    );
    return {
      message: `Child ${args.id} completed`,
    };
  },
  activityOptions: {
    startToCloseTimeout: "1 minute",
  },
});

// Workflow that calls failable activity
export const workflowWithFailableActivity = declareWorkflow({
  workflowName: "workflowWithFailableActivity",
  contract: testContract,
  implementation: async ({ activities }, args) => {
    // The (skipped) "Error Handling" spec in worker.spec.ts expects the
    // workflow itself to FAIL when the activity fails — not to fold the
    // failure into a returned status — so let it escape via
    // propagateActivityFailure rather than narrowing.
    return await propagateActivityFailure(
      activities.failableActivity({ shouldFail: args.shouldFail }),
    );
  },
  activityOptions: {
    startToCloseTimeout: "1 minute",
  },
});
