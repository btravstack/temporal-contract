# @temporal-contract/worker

> Type-safe worker implementation for Temporal

[![npm version](https://img.shields.io/npm/v/@temporal-contract/worker.svg?logo=npm)](https://www.npmjs.com/package/@temporal-contract/worker)

## Installation

```bash
pnpm add @temporal-contract/worker @temporal-contract/contract @temporalio/workflow zod
```

## Quick Example

```typescript
// activities.ts
import { declareActivitiesHandler, ApplicationFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

export const activities = declareActivitiesHandler({
  contract: myContract,
  activities: {
    sendEmail: ({ to, body }) =>
      fromPromise(emailService.send({ to, body }), (error) =>
        ApplicationFailure.create({
          type: "EMAIL_FAILED",
          message: error instanceof Error ? error.message : "Failed to send email",
          cause: error,
        }),
      ).map(() => ({ sent: true })),
  },
});

// workflows.ts
import { declareWorkflow } from "@temporal-contract/worker/workflow";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async ({ activities }, input) => {
    // Activities return plain values (Result is unwrapped internally)
    await activities.sendEmail({ to: "user@example.com", body: "Done!" });
    return { success: true };
  },
});

// worker.ts
import { Worker } from "@temporalio/worker";
import { activities } from "./activities";
import myContract from "./contract";

async function run() {
  const worker = await Worker.create({
    workflowsPath: require.resolve("./workflows"),
    activities,
    taskQueue: myContract.taskQueue,
  });

  await worker.run();
}

run().catch(console.error);
```

### Child Workflows

Execute child workflows with type-safe `AsyncResult`. Supports both same-contract and cross-contract child workflows:

```typescript
// workflows.ts
import { declareWorkflow } from "@temporal-contract/worker/workflow";

export const parentWorkflow = declareWorkflow({
  workflowName: "parentWorkflow",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, input) => {
    // Execute child workflow from same contract and wait for result
    const childResult = await context.executeChildWorkflow(myContract, "processPayment", {
      workflowId: `payment-${input.orderId}`,
      args: { amount: input.totalAmount },
    });

    childResult.match(
      (output) => console.log("Payment processed:", output),
      (error) => console.error("Payment failed:", error),
    );

    // Execute child workflow from another contract (another worker)
    const notificationResult = await context.executeChildWorkflow(
      notificationContract,
      "sendNotification",
      {
        workflowId: `notification-${input.orderId}`,
        args: { message: "Order received" },
      },
    );

    // Or start child workflow without waiting
    const handleResult = await context.startChildWorkflow(myContract, "sendEmail", {
      workflowId: `email-${input.orderId}`,
      args: { to: "user@example.com", body: "Order received" },
    });

    handleResult.match(
      async (handle) => {
        // Can wait for result later
        const result = await handle.result();
        // ...
      },
      (error) => console.error("Failed to start:", error),
    );

    return { success: true };
  },
});
```

### Per-activity options

`activityOptions` sets defaults for every activity reachable from the workflow.
To override options for individual activities, add `activityOptionsByName`. Each
entry shallow-merges over the defaults — the override wins on every property it
sets, including the whole nested `retry` block.

The override value is Temporal's full `ActivityOptions`, so `taskQueue` is
available too. That lets you route specific activities to dedicated worker pools
(e.g. a concurrency-capped queue for LLM calls) while the rest of the workflow
stays on the default queue — without dropping to a raw `proxyActivities` call,
which would bypass the Zod input/output validation:

```typescript
export const extractLayout = declareWorkflow({
  workflowName: "extractLayout",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "10 minutes" }, // default for all
  activityOptionsByName: {
    // LLM activity → dedicated, concurrency-capped queue.
    extractLayoutChunk: { taskQueue: "gemini-pro" },
    // Slow payment gateway → longer timeout + aggressive retry.
    chargePayment: {
      startToCloseTimeout: "5 minutes",
      retry: { maximumAttempts: 5 },
    },
    // Activities not listed here fall through to the default queue/options.
  },
  implementation: async ({ activities }, input) => {
    // Each call still validates input/output against the contract.
    const layout = await activities.extractLayoutChunk({ docId: input.docId });
    return { layout };
  },
});
```

Activity names are typed against the contract (workflow-local + global), so
typos surface as TypeScript errors rather than silently running with defaults.

## Documentation

📖 **[Read the full documentation →](https://btravstack.github.io/temporal-contract)**

- [API Reference](https://btravstack.github.io/temporal-contract/api/worker)
- [Worker Implementation Guide](https://btravstack.github.io/temporal-contract/guide/worker-implementation)
- [Examples](https://btravstack.github.io/temporal-contract/examples/)

## License

MIT
