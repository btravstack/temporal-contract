import { isOk, isErr } from "unthrown";
import { testContract } from "./test.contract.js";
import { declareWorkflow } from "../workflow.js";
import { sleep } from "@temporalio/workflow";

export const simpleWorkflow = declareWorkflow({
  workflowName: "simpleWorkflow",
  contract: testContract,
  implementation: async ({ activities }, args) => {
    await activities.logMessage({ message: `Processing: ${args.value}` });
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
    // Validate order
    const validationResult = await activities.validateOrder({ orderId: args.orderId });

    if (!validationResult.valid) {
      return {
        orderId: args.orderId,
        status: "failed" as const,
        reason: "Invalid order ID",
      };
    }

    // Process payment
    const paymentResult = await activities.processPayment({ amount: args.amount });

    if (!paymentResult.success) {
      return {
        orderId: args.orderId,
        status: "failed" as const,
        reason: "Payment failed",
      };
    }

    // Log success
    await activities.logMessage({
      message: `Order ${args.orderId} completed with transaction ${paymentResult.transactionId}`,
    });

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
  implementation: async ({ defineSignal, defineQuery, defineUpdate }, args) => {
    let currentValue = 0;

    currentValue = args.initialValue;

    // Define signal, query, and update handlers with access to workflow state
    defineSignal("increment", async (signalArgs) => {
      currentValue += signalArgs.amount;
    });

    defineQuery("getCurrentValue", () => {
      return { value: currentValue };
    });

    defineUpdate("multiply", async (updateArgs) => {
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

      if (isOk(childResult)) {
        results.push(childResult.value.message);
      } else if (isErr(childResult)) {
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
    await activities.logMessage({ message: `Child workflow ${args.id} running` });
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
    const result = await activities.failableActivity({ shouldFail: args.shouldFail });
    return {
      success: result.success,
    };
  },
  activityOptions: {
    startToCloseTimeout: "1 minute",
  },
});
