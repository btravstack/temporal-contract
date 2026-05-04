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
import { ResultAsync } from "neverthrow";

export const activities = declareActivitiesHandler({
  contract: myContract,
  activities: {
    sendEmail: ({ to, body }) =>
      ResultAsync.fromPromise(emailService.send({ to, body }), (error) =>
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

Execute child workflows with type-safe `ResultAsync`. Supports both same-contract and cross-contract child workflows:

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

## Documentation

📖 **[Read the full documentation →](https://btravers.github.io/temporal-contract)**

- [API Reference](https://btravers.github.io/temporal-contract/api/worker)
- [Worker Implementation Guide](https://btravers.github.io/temporal-contract/guide/worker-implementation)
- [Examples](https://btravers.github.io/temporal-contract/examples/)

## License

MIT
