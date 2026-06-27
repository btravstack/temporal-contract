# Worker Usage

Learn how to implement and run type-safe workers with temporal-contract.

## Overview

The `@temporal-contract/worker` package provides type-safe implementations for workflows and activities based on your contract definitions.

## Installation

```bash
pnpm add @temporal-contract/worker unthrown
```

## Implementing Activities

Activities use `unthrown` for explicit error handling:

```typescript
import { declareActivitiesHandler, ApplicationFailure } from "@temporal-contract/worker/activity";
import { fromPromise, ok } from "unthrown";
import { myContract } from "./contract";

export const activities = declareActivitiesHandler({
  contract: myContract,
  activities: {
    // Global activities
    log: ({ level, message }) => {
      console.log(`[${level}] ${message}`);
      return Ok(undefined).toAsync();
    },

    // Workflow-specific activities
    processOrder: {
      processPayment: ({ customerId, amount }) =>
        fromPromise(paymentService.charge(customerId, amount), (error) =>
          ApplicationFailure.create({
            type: "PAYMENT_FAILED",
            message: error instanceof Error ? error.message : "Payment processing failed",
            cause: error instanceof Error ? error : undefined,
          }),
        ).map((result) => ({ transactionId: result.id })),
    },
  },
});
```

## Implementing Workflows

Workflows return plain objects (not `Result`) due to network serialization. Activities called in workflows return plain values (the `Result` is unwrapped by the framework):

```typescript
import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { myContract } from "./contract";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, args) => {
    // Activities return plain values (Result is unwrapped internally)
    const payment = await context.activities.processPayment({
      customerId: args.customerId,
      amount: args.amount,
    });

    await context.activities.log({
      level: "info",
      message: `Order ${args.orderId} processed with transaction ${payment.transactionId}`,
    });

    // Return plain object (not Result - network serialization requirement)
    return {
      success: true,
      transactionId: payment.transactionId,
    };
  },
});
```

## Starting a Worker

```typescript
import { Worker } from "@temporalio/worker";
import { myContract } from "./contract";
import { activities } from "./activities";

async function main() {
  const worker = await Worker.create({
    workflowsPath: require.resolve("./workflows"),
    activities,
    taskQueue: myContract.taskQueue,
  });

  console.log("Worker started, listening on task queue:", myContract.taskQueue);
  await worker.run();
}

main().catch((error) => {
  console.error("Worker failed:", error);
  process.exit(1);
});
```

## Activity Error Handling

### `ApplicationFailure`

`ApplicationFailure` (re-exported from `@temporal-contract/worker/activity`) is Temporal's first-class failure shape. Use it to wrap technical exceptions with a `type` field, optional `cause`, and the per-instance `nonRetryable` flag:

```typescript
import { ApplicationFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

processPayment: ({ customerId, amount }) =>
  fromPromise(paymentService.charge(customerId, amount), (error) =>
    ApplicationFailure.create({
      type: "PAYMENT_FAILED", // categorizes the failure for retry policies / search
      message: error instanceof Error ? error.message : "Payment failed",
      // `nonRetryable: true` would tell Temporal to skip the retry policy
      // for this attempt — useful for permanent failures like a declined card.
      nonRetryable: false,
      ...(error instanceof Error ? { cause: error } : {}),
    }),
  ).map((transaction) => ({ transactionId: transaction.id }));
```

### Error Propagation

Activity errors are automatically propagated to workflows:

```typescript
const payment = await activities.processPayment({ customerId, amount });

// Activities return plain values - framework handles errors internally
// If an activity fails, the workflow will fail automatically
console.log("Payment successful:", payment.transactionId);
```

## Workflow Context

The workflow context provides typed access to activities:

```typescript
implementation: async (context, args) => {
  // Execute activities
  const result = await context.activities.someActivity(args);

  // Access workflow info
  console.log("Workflow ID:", context.info.workflowId);
  console.log("Run ID:", context.info.runId);

  // Use Temporal sleep (import from @temporalio/workflow)
  // import { sleep } from "@temporalio/workflow";
  await sleep("1 hour");

  return { success: true };
};
```

## Child Workflows

Execute child workflows with type safety using the `Result` / `AsyncResult` pattern:

```typescript
import { declareWorkflow } from "@temporal-contract/worker/workflow";

export const parentWorkflow = declareWorkflow({
  workflowName: "parentWorkflow",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, args) => {
    // Execute child workflow - returns AsyncResult<T, E>
    const childResult = await context.executeChildWorkflow(myContract, "processPayment", {
      workflowId: `payment-${args.orderId}`,
      args: { amount: args.amount, customerId: args.customerId },
    });

    // Handle the Result with pattern matching (object form, three channels)
    return childResult.match({
      ok: (output) => ({
        success: true,
        transactionId: output.transactionId,
      }),
      err: (error) => ({
        success: false,
        error: error.message,
      }),
      defect: (cause) => ({
        success: false,
        error: cause instanceof Error ? cause.message : "Unexpected failure",
      }),
    });
  },
});
```

## Graceful Shutdown

Handle shutdown signals properly:

```typescript
async function main() {
  const worker = await Worker.create({
    workflowsPath: require.resolve("./workflows"),
    activities,
    taskQueue: myContract.taskQueue,
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down worker...");
    await worker.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("Worker started");
  await worker.run();
}
```

## Multiple Workers

Run multiple workers with different contracts:

```typescript
const orderWorker = await Worker.create({
  workflowsPath: require.resolve("./order-workflows"),
  activities: orderActivities,
  taskQueue: orderContract.taskQueue,
});

const paymentWorker = await Worker.create({
  workflowsPath: require.resolve("./payment-workflows"),
  activities: paymentActivities,
  taskQueue: paymentContract.taskQueue,
});

// Run both workers concurrently
await Promise.all([orderWorker.run(), paymentWorker.run()]);
```

## Testing

Test activities and workflows in isolation:

```typescript
import { describe, it, expect } from "vitest";
import { isOk } from "unthrown";
import { activities } from "./activities";

describe("Activities", () => {
  it("should process payment successfully", async () => {
    const result = await activities.processPayment({
      customerId: "CUST-123",
      amount: 100,
    });

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({
        transactionId: expect.any(String),
      });
    }
  });
});
```

## Best Practices

### 1. Use `fromPromise` with `.map` / `.mapErr` for Activities

Activities should pass the error mapper directly to `fromPromise`
and chain `.map` for the success path:

```typescript
// ✅ Good - explicit error handling with fromPromise
processPayment: ({ amount }) =>
  fromPromise(paymentService.charge(amount), (err) =>
    ApplicationFailure.create({
      type: "PAYMENT_FAILED",
      message: err instanceof Error ? err.message : "Payment failed",
      cause: err instanceof Error ? err : undefined,
    }),
  ).map((tx) => ({ transactionId: tx.id }));

// ❌ Avoid - hand-rolling a Promise<Result> with try/catch
processPayment: ({ amount }) =>
  fromPromise(
    (async () => {
      try {
        const tx = await paymentService.charge(amount);
        return Ok({ transactionId: tx.id });
      } catch (err) {
        return Err(/* ... */);
      }
    })(),
    (e) => e,
  );
```

### 2. Activities Return Plain DTOs (Not Result)

Activities internally return a `Result`, but the framework unwraps it for
network serialization:

```typescript
// ✅ Good - activity returns AsyncResult<T, ApplicationFailure>
// Framework unwraps to plain DTO over network
processPayment: ({ amount }) =>
  fromPromise(paymentService.charge(amount), (err) =>
    ApplicationFailure.create({
      type: "PAYMENT_FAILED",
      message: err instanceof Error ? err.message : "Payment failed",
      cause: err instanceof Error ? err : undefined,
    }),
  ).map((tx) => ({ transactionId: tx.id }));

// In the workflow, you receive the plain value:
const payment = await activities.processPayment({ amount: 100 });
// payment is { transactionId: string }, not Result
```

### 3. Workflows Return Plain Objects (Not Result)

Workflows cannot return `Result` due to network serialization:

```typescript
// ✅ Good - return plain object
implementation: async (context, args) => {
  const payment = await context.activities.processPayment({ amount: 100 });
  return { success: true, transactionId: payment.transactionId };
};

// ❌ Avoid - returning Result (will lose instance over network)
implementation: async (context, args) => {
  const payment = await context.activities.processPayment({ amount: 100 });
  return Ok({ transactionId: payment.transactionId }); // Won't work!
};
```

### 4. Use Descriptive Error Codes

```typescript
// ✅ Good - clear error codes
ApplicationFailure.create({ type: "PAYMENT_GATEWAY_TIMEOUT", message: "Gateway did not respond" });
ApplicationFailure.create({
  type: "INSUFFICIENT_FUNDS",
  message: "Customer has insufficient balance",
});

// ❌ Avoid - generic errors
ApplicationFailure.create({ type: "ERROR", message: "Something went wrong" });
```

## See Also

- [Defining Contracts](/guide/defining-contracts) - Creating contract definitions
- [Client Usage](/guide/client-usage) - Executing workflows from clients
- [Result Pattern](/guide/result-pattern) - Understanding Result/AsyncResult patterns
- [API Reference](/api/worker) - Complete worker API documentation
