import { z } from "zod";
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";

// Composition-first: resources are defined individually, then composed into
// the contract (never inlined in `defineContract`).

const charge = defineActivity({
  input: z.object({ amount: z.number() }),
  output: z.object({ transactionId: z.string() }),
  errors: {
    PaymentDeclined: {
      data: z.object({ reason: z.string() }),
      nonRetryable: true,
    },
  },
  // Contract-level defaults — `declareWorkflow` omits `activityOptions`.
  defaultOptions: { startToCloseTimeout: "10 seconds" },
});

const placeOrder = defineWorkflow({
  input: z.object({ orderId: z.string(), amount: z.number() }),
  output: z.object({ status: z.string() }),
  errors: {
    EmptyOrder: {
      data: z.object({ orderId: z.string() }),
      nonRetryable: true,
    },
  },
  activities: { charge },
});

export const inprocessContract = defineContract({
  taskQueue: "inprocess-tests",
  workflows: { placeOrder },
});
