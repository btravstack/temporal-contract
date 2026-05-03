# Worker Implementation

This guide explains how to implement workers using temporal-contract.

## Overview

The `@temporal-contract/worker` package provides functions for implementing Temporal workers with full type safety:

1. **`declareActivitiesHandler`** - Implements all activities (global + workflow-specific)
2. **`declareWorkflow`** - Implements individual workflows with typed context

## Workflow Execution Flow

```mermaid
sequenceDiagram
    participant Client
    participant Worker
    participant Workflow
    participant Activities

    Client->>Worker: Execute workflow (typed)
    Worker->>Workflow: Start with validated input
    Workflow->>Activities: Call activity (typed)
    Activities->>Activities: Validate input
    Activities->>Activities: Execute logic
    Activities->>Activities: Validate output
    Activities->>Workflow: Return result (typed)
    Workflow->>Worker: Return output (validated)
    Worker->>Client: Result (typed)
```

## Activities Handler

Create a handler for all activities using the Result/Future pattern:

```typescript
import { declareActivitiesHandler, ActivityError } from "@temporal-contract/worker/activity";
import { Future, Result } from "@swan-io/boxed";
import { myContract } from "./contract";

export const activities = declareActivitiesHandler({
  contract: myContract,
  activities: {
    // Global activities - use Future/Result for explicit error handling
    sendEmail: ({ to, subject, body }) => {
      return Future.fromPromise(emailService.send({ to, subject, body }))
        .mapError(
          (error) =>
            new ActivityError(
              "EMAIL_FAILED",
              error instanceof Error ? error.message : "Failed to send email",
              error,
            ),
        )
        .mapOk(() => ({ sent: true }));
    },

    // Workflow-specific activities
    processPayment: ({ customerId, amount }) => {
      return Future.fromPromise(paymentGateway.charge(customerId, amount))
        .mapError(
          (error) =>
            new ActivityError(
              "PAYMENT_FAILED",
              error instanceof Error ? error.message : "Payment failed",
              error,
            ),
        )
        .mapOk((txId) => ({ transactionId: txId, success: true }));
    },
  },
});
```

## Working with the Activity Context

`declareActivitiesHandler` validates inputs/outputs and folds errors into the
`Future<Result<...>>` shape, but it does **not** hide Temporal's
`@temporalio/activity` runtime — your handler still runs as an ordinary
Temporal activity. To reach Temporal's `Context.current()` (heartbeats, last
heartbeat payload, attempt number, async completion), import it directly
inside the activity body. The contract surface stays clean while you keep
full access to Temporal's activity APIs.

### Heartbeat (long-running activities)

Long-running activities must heartbeat to avoid `startToCloseTimeout` /
`heartbeatTimeout` failures. Call `Context.current().heartbeat(details)`
from inside your `Future`-returning body — heartbeats are independent of
the Result/Future wrapping:

```typescript
import { Context } from "@temporalio/activity";
import { Future } from "@swan-io/boxed";
import { ActivityError } from "@temporal-contract/worker/activity";
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";
import { reportContract } from "./contract";

type Handlers = ActivitiesHandler<typeof reportContract>;

export const exportLargeReport: Handlers["exportLargeReport"] = ({ reportId }) => {
  return Future.fromPromise(
    runExport(reportId, ({ chunkIndex }) => {
      // Heartbeat the most recent progress checkpoint. Temporal records
      // this as the activity's `heartbeatDetails` for the next attempt.
      Context.current().heartbeat({ chunkIndex });
    }),
  )
    .mapError((error) => new ActivityError("EXPORT_FAILED", String(error), error))
    .mapOk(({ rowCount }) => ({ rowCount }));
};
```

Pair this with `heartbeatTimeout` on the workflow side (`activityOptions` or
`activityOptionsByName`) so Temporal can detect a stalled worker.

### Resuming after a retry (`heartbeatDetails`)

When Temporal retries a heartbeating activity, the previous attempt's last
`heartbeat(details)` payload is available on `Context.current().heartbeatDetails`.
Use it to skip work the previous attempt already completed:

```typescript
import { Context } from "@temporalio/activity";

export const exportLargeReport: Handlers["exportLargeReport"] = ({ reportId }) => {
  // `heartbeatDetails` is typed as `unknown` — the contract surface does
  // not yet validate this payload (see issue #198 for the typed-schema
  // follow-up). Cast at the boundary if you need typed access.
  const last = Context.current().heartbeatDetails as { chunkIndex: number } | undefined;
  const startFrom = last?.chunkIndex ?? 0;

  return Future.fromPromise(runExport(reportId, { startFrom }))
    .mapError((error) => new ActivityError("EXPORT_FAILED", String(error), error))
    .mapOk(({ rowCount }) => ({ rowCount }));
};
```

### Activity info (attempt number, workflow IDs)

`Context.current().info` exposes the running activity's metadata: attempt
number, workflow execution ID, task queue, schedule timestamps, and so on.
Useful for structured logging and conditional retry behavior:

```typescript
import { Context } from "@temporalio/activity";

export const chargePayment: Handlers["chargePayment"] = ({ orderId, amount }) => {
  const { attempt, workflowExecution } = Context.current().info;
  logger.info("chargePayment attempt", {
    attempt,
    workflowId: workflowExecution.workflowId,
    orderId,
  });
  // ...
};
```

### Async completion

Activities that pause and complete out of band (HTTP callback, message
queue, manual approval) use Temporal's standard async completion pattern.
Inside the activity, capture the task token and tell Temporal not to
auto-complete the activity:

```typescript
import { Context, CompleteAsyncError } from "@temporalio/activity";

export const awaitApproval: Handlers["awaitApproval"] = ({ requestId }) => {
  const taskToken = Context.current().info.taskToken;

  return Future.fromPromise(
    enqueueApprovalRequest({ requestId, taskToken }).then(() => {
      // Tell Temporal the activity will be completed asynchronously.
      throw new CompleteAsyncError();
    }),
  ).mapOk(() => ({ awaiting: true }));
};
```

The external system later finishes the activity by calling
[`AsyncCompletionClient`](https://typescript.temporal.io/api/classes/client.AsyncCompletionClient/)
with the task token. The library does not currently wrap
`AsyncCompletionClient` — use it directly from `@temporalio/client` in
whichever process completes the activity.

### Where to draw the line

The contract surface aims to type **inputs and outputs** at the network
boundary. Activity-runtime concerns (heartbeats, attempt number, async
completion) are not part of the contract today and remain in
`@temporalio/activity`. If a future contract upgrade introduces a typed
heartbeat schema or an `AsyncCompletionClient` wrapper, it will live
behind a new `defineActivity({ heartbeatDetails: ... })` field rather
than replacing this escape hatch.

## Workflow Implementation

Implement workflows with typed context. Activities called from workflows return plain values (Result is unwrapped internally):

```typescript
import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { myContract } from "./contract";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, args) => {
    // context.activities is fully typed
    // Activities return plain values (Result is unwrapped by the framework)
    const payment = await context.activities.processPayment({
      customerId: args.customerId,
      amount: 100,
    });

    await context.activities.sendEmail({
      to: args.customerId,
      subject: "Order Confirmed",
      body: "Your order has been processed",
    });

    // Return plain object (not Result)
    return {
      status: payment.success ? "success" : "failed",
      transactionId: payment.transactionId,
    };
  },
});
```

### Per-activity options

`activityOptions` applies to every activity reachable from the workflow. To
override timeouts or retry policy for a specific activity, add
`activityOptionsByName`. Each entry shallow-merges over the workflow default;
the override wins on every property it specifies, including the entire nested
`retry` block (matching Temporal's "one `ActivityOptions` per
`proxyActivities` call" semantics).

```typescript
export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: myContract,
  activityOptions: {
    startToCloseTimeout: "1 minute",
  },
  activityOptionsByName: {
    // Payment gateway is slow and worth retrying aggressively
    processPayment: {
      startToCloseTimeout: "5 minutes",
      retry: { maximumAttempts: 5 },
    },
    // Cheap CPU-bound check — fail fast if it stalls
    validateOrder: {
      startToCloseTimeout: "5 seconds",
    },
  },
  implementation: async (context, args) => {
    // ...
  },
});
```

Activity names in `activityOptionsByName` are constrained to the contract's
declared activities (workflow-local + global), so typos surface at compile
time rather than running silently with the default options.

## Worker Setup

Set up the Temporal worker:

```typescript
import { Worker } from "@temporalio/worker";
import { activities } from "./activities";

const worker = await Worker.create({
  workflowsPath: require.resolve("./workflows"),
  activities,
  taskQueue: "my-task-queue", // or myContract.taskQueue
});

await worker.run();
```

## Type Safety Features

### Input Validation

All activity and workflow inputs are automatically validated:

```typescript
// ✅ Valid - matches schema
await context.activities.processPayment({
  customerId: "CUST-123",
  amount: 100,
});

// ❌ Invalid - throws validation error
await context.activities.processPayment({
  customerId: 123, // Should be string
  amount: -10, // Should be positive
});
```

### Output Validation

Return values are validated against output schemas:

```typescript
// ✅ Valid
return { transactionId: "TXN-123", success: true };

// ❌ Invalid - TypeScript error + runtime validation
return { txId: "TXN-123" }; // Wrong field name
```

### Typed Context

The workflow context is fully typed based on your contract:

```typescript
implementation: async (context, args) => {
  // TypeScript knows all available activities
  context.activities.processPayment; // ✅ Available
  context.activities.unknownActivity; // ❌ TypeScript error

  // Full autocomplete for parameters
  await context.activities.processPayment({
    // IDE shows: customerId: string, amount: number
  });
};
```

## Child Workflows

Execute child workflows with type-safe Future/Result pattern. Child workflows can be from the same contract or from a different contract (cross-worker communication).

```mermaid
graph TB
    subgraph PW[Parent Workflow]
        P[Parent Logic]
    end

    subgraph SC[Same Contract]
        CW1[Child Workflow 1]
    end

    subgraph DC[Different Contract]
        CW2[Child Workflow 2]
    end

    P -->|executeChildWorkflow| CW1
    P -->|executeChildWorkflow<br/>cross-contract| CW2
    CW1 -->|Result| P
    CW2 -->|Result| P

    style PW fill:#3b82f6,stroke:#1e40af,color:#fff
    style SC fill:#10b981,stroke:#059669,color:#fff
    style DC fill:#8b5cf6,stroke:#6d28d9,color:#fff
```

### Basic Usage

```typescript
import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { myContract, notificationContract } from "./contracts";

export const parentWorkflow = declareWorkflow({
  workflowName: "parentWorkflow",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, args) => {
    // Execute child workflow from same contract and wait for result
    const result = await context.executeChildWorkflow(myContract, "processPayment", {
      workflowId: `payment-${args.orderId}`,
      args: { amount: args.totalAmount },
    });

    result.match({
      Ok: (output) => console.log("Payment processed:", output),
      Error: (error) => console.error("Payment failed:", error),
    });

    return { success: true };
  },
});
```

### Cross-Contract Child Workflows

Invoke child workflows from different contracts and workers:

```typescript
export const orderWorkflow = declareWorkflow({
  workflowName: "processOrder",
  contract: orderContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, args) => {
    // Process payment in same contract
    const paymentResult = await context.executeChildWorkflow(orderContract, "processPayment", {
      workflowId: `payment-${args.orderId}`,
      args: { amount: args.total },
    });

    if (paymentResult.isError()) {
      return { status: "failed", reason: "payment" };
    }

    // Send notification using another worker's contract
    const notificationResult = await context.executeChildWorkflow(
      notificationContract,
      "sendOrderConfirmation",
      {
        workflowId: `notify-${args.orderId}`,
        args: { orderId: args.orderId, email: args.customerEmail },
      },
    );

    return {
      status: "completed",
      transactionId: paymentResult.value.transactionId,
    };
  },
});
```

### Start Without Waiting

Use `startChildWorkflow` to start a child workflow without waiting for its result:

```typescript
export const orderWorkflow = declareWorkflow({
  workflowName: "processOrder",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, args) => {
    // Start background notification workflow
    const handleResult = await context.startChildWorkflow(notificationContract, "sendEmail", {
      workflowId: `email-${args.orderId}`,
      args: { to: args.customerEmail, subject: "Order received" },
    });

    handleResult.match({
      Ok: async (handle) => {
        // Child workflow started successfully
        // Can wait for result later if needed
        const result = await handle.result();
      },
      Error: (error) => {
        console.error("Failed to start notification:", error);
      },
    });

    return { success: true };
  },
});
```

### Error Handling

Child workflow errors are returned as `ChildWorkflowError`:

```typescript
const result = await context.executeChildWorkflow(myContract, "processPayment", {
  workflowId: "payment-123",
  args: { amount: 100 },
});

result.match({
  Ok: (output) => {
    // Child workflow completed successfully
    console.log("Transaction ID:", output.transactionId);
  },
  Error: (error) => {
    // Handle child workflow errors
    if (error instanceof ChildWorkflowNotFoundError) {
      console.error("Workflow not found in contract");
    } else {
      console.error("Child workflow failed:", error.message);
    }
  },
});
```

## Best Practices

### 1. Separate Activity Files

Organize activities by domain:

```typescript
// activities/payment.ts
import { Future, Result } from "@swan-io/boxed";
import { ActivityError } from "@temporal-contract/worker/activity";

export const paymentActivities = {
  processPayment: ({ customerId, amount }) => {
    return Future.fromPromise(paymentGateway.charge(customerId, amount))
      .mapError((err) => new ActivityError("PAYMENT_FAILED", err.message, err))
      .mapOk((tx) => ({ transactionId: tx.id }));
  },
  refundPayment: ({ transactionId }) => {
    return Future.fromPromise(paymentGateway.refund(transactionId))
      .mapError((err) => new ActivityError("REFUND_FAILED", err.message, err))
      .mapOk(() => ({ refunded: true }));
  },
};

// activities/email.ts
import { Future, Result } from "@swan-io/boxed";
import { ActivityError } from "@temporal-contract/worker/activity";

export const emailActivities = {
  sendEmail: ({ to, subject, body }) => {
    return Future.fromPromise(emailService.send({ to, subject, body }))
      .mapError((err) => new ActivityError("EMAIL_FAILED", err.message, err))
      .mapOk(() => ({ sent: true }));
  },
};

// activities/index.ts
import { declareActivitiesHandler } from "@temporal-contract/worker/activity";
import { paymentActivities } from "./payment";
import { emailActivities } from "./email";

export const activities = declareActivitiesHandler({
  contract: myContract,
  activities: {
    ...paymentActivities,
    ...emailActivities,
  },
});
```

### 2. Use Dependency Injection

Make activities testable:

```typescript
import { Future, Result } from "@swan-io/boxed";
import { ActivityError } from "@temporal-contract/worker/activity";

export const createActivities = (services: {
  emailService: EmailService;
  paymentGateway: PaymentGateway;
}) =>
  declareActivitiesHandler({
    contract: myContract,
    activities: {
      sendEmail: ({ to, subject, body }) => {
        return Future.fromPromise(services.emailService.send({ to, subject, body }))
          .mapError((err) => new ActivityError("EMAIL_FAILED", err.message, err))
          .mapOk(() => ({ sent: true }));
      },
      processPayment: ({ customerId, amount }) => {
        return Future.fromPromise(services.paymentGateway.charge(customerId, amount))
          .mapError((err) => new ActivityError("PAYMENT_FAILED", err.message, err))
          .mapOk((txId) => ({ transactionId: txId, success: true }));
      },
    },
  });
```

### 3. Error Handling

Activities use the Future/Result pattern for explicit error handling:

```typescript
import { declareActivitiesHandler, ActivityError } from "@temporal-contract/worker/activity";
import { Future, Result } from "@swan-io/boxed";

export const activities = declareActivitiesHandler({
  contract: myContract,
  activities: {
    processPayment: ({ customerId, amount }) => {
      return Future.fromPromise(paymentGateway.charge(customerId, amount))
        .mapError((error) => {
          // Wrap technical errors in ActivityError
          // This enables proper retry policies and error handling
          return new ActivityError(
            "PAYMENT_FAILED",
            error instanceof Error ? error.message : "Payment failed",
            error,
          );
        })
        .mapOk((txId) => ({ transactionId: txId, success: true }));
    },
  },
});
```

In workflows, activities return plain values. If an activity fails, it will throw an error that can be caught:

```typescript
export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, args) => {
    try {
      // Activity returns plain value if successful
      const payment = await context.activities.processPayment({
        customerId: args.customerId,
        amount: 100,
      });

      return {
        status: "success",
        transactionId: payment.transactionId,
      };
    } catch (error) {
      // Activity errors are thrown and can be caught
      console.error("Payment failed:", error);

      return {
        status: "failed",
        transactionId: "",
      };
    }
  },
});
```

## See Also

- [Entry Points Architecture](/guide/entry-points)
- [Activity Handler Types](/guide/activity-handlers)
- [Examples](/examples/)
