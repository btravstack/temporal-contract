# Client Usage

Learn how to use the typed client to execute workflows with full type safety.

## Overview

The `@temporal-contract/client` package provides a type-safe wrapper around Temporal's client that enforces your contract definitions at compile time.

## Installation

```bash
pnpm add @temporal-contract/client unthrown
```

## Basic Setup

```typescript
import { Connection, Client } from "@temporalio/client";
import { TypedClient } from "@temporal-contract/client";
import { myContract } from "./contract.js";

// Connect to Temporal
const connection = await Connection.connect({
  address: "localhost:7233",
});

// Create Temporal client and typed client
const temporalClient = new Client({ connection });
// Creation returns AsyncResult<TypedClient, never> — connection and capability
// failures are technical faults that ride the defect channel (a TechnicalError
// instance as the cause), not the modeled Err channel, and are never thrown.
const clientResult = await TypedClient.create({
  contract: myContract,
  client: temporalClient,
});
if (clientResult.isDefect()) {
  // The defect's cause is a TechnicalError describing the setup failure.
  throw clientResult.cause;
}
const client = clientResult.value;
```

## Executing Workflows

### Basic Execution

Execute a workflow and wait for completion. `executeWorkflow` returns an
`AsyncResult<T, E>` — `await` it to get a `Result<T, E>`:

```typescript
const resultAsync = client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: {
    orderId: "ORD-123",
    customerId: "CUST-456",
  },
});

// await the AsyncResult to get the Result
const result = await resultAsync;

// Handle the Result with pattern matching (object form, three channels)
result.match({
  ok: (output) => {
    console.log("Order processed:", output.status); // TypeScript knows the shape!
  },
  errCases: (matcher) =>
    matcher.with(
      tag("@temporal-contract/ContractError"),
      tag("@temporal-contract/WorkflowNotFoundError"),
      tag("@temporal-contract/WorkflowValidationError"),
      tag("@temporal-contract/WorkflowAlreadyStartedError"),
      tag("@temporal-contract/WorkflowFailedError"),
      tag("@temporal-contract/WorkflowExecutionNotFoundError"),
      (error) => {
        console.error("Workflow failed:", error);
      },
    ),
  defect: (cause) => {
    console.error("Unexpected failure:", cause);
  },
});
```

### Start Without Waiting

Start a workflow without waiting for completion:

```typescript
const handleResult = await client.startWorkflow("processOrder", {
  workflowId: "order-123",
  args: {
    orderId: "ORD-123",
    customerId: "CUST-456",
  },
});

handleResult.match({
  ok: async (handle) => {
    // Get workflow ID
    console.log("Started workflow:", handle.workflowId);

    // Wait for result later
    const result = await handle.result();
    result.match({
      ok: (output) => console.log("Completed:", output),
      errCases: (matcher) =>
        matcher.with(
          tag("@temporal-contract/ContractError"),
          tag("@temporal-contract/WorkflowValidationError"),
          tag("@temporal-contract/WorkflowFailedError"),
          tag("@temporal-contract/WorkflowExecutionNotFoundError"),
          (error) => console.error("Failed:", error),
        ),
      defect: (cause) => console.error("Unexpected failure:", cause),
    });
  },
  errCases: (matcher) =>
    matcher.with(
      tag("@temporal-contract/WorkflowNotFoundError"),
      tag("@temporal-contract/WorkflowValidationError"),
      tag("@temporal-contract/WorkflowAlreadyStartedError"),
      (error) => {
        console.error("Failed to start workflow:", error);
      },
    ),
  defect: (cause) => {
    console.error("Unexpected failure:", cause);
  },
});
```

## Type Safety

The typed client provides compile-time safety:

```typescript
// ✅ Correct - TypeScript validates args
await client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: {
    orderId: "ORD-123",
    customerId: "CUST-456",
  },
});

// ❌ Error - Missing required field
await client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: {
    orderId: "ORD-123",
    // customerId is missing - TypeScript error!
  },
});

// ❌ Error - Wrong workflow name
await client.executeWorkflow("invalidWorkflow", {
  workflowId: "order-123",
  args: {/* ... */},
});
```

## Result Pattern

The client uses `unthrown` for explicit error handling:

```typescript
import { Result, tag } from "unthrown";

const result = await client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: { orderId: "ORD-123", customerId: "CUST-456" },
});

// Handle result with pattern matching (object form, three channels)
result.match({
  ok: (value) => {
    console.log("Order processed:", value.transactionId);
  },
  errCases: (matcher) =>
    matcher.with(
      tag("@temporal-contract/ContractError"),
      tag("@temporal-contract/WorkflowNotFoundError"),
      tag("@temporal-contract/WorkflowValidationError"),
      tag("@temporal-contract/WorkflowAlreadyStartedError"),
      tag("@temporal-contract/WorkflowFailedError"),
      tag("@temporal-contract/WorkflowExecutionNotFoundError"),
      (error) => {
        console.error("Order failed:", error);
      },
    ),
  defect: (cause) => {
    console.error("Unexpected failure:", cause);
  },
});
```

## Workflow Options

Pass standard Temporal workflow options:

```typescript
await client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: { orderId: "ORD-123", customerId: "CUST-456" },

  // Standard Temporal options (taskQueue comes from the contract automatically)
  workflowExecutionTimeout: "1 hour",
  workflowRunTimeout: "30 minutes",
  retry: {
    maximumAttempts: 3,
  },
  memo: {
    description: "Customer order processing",
  },
  searchAttributes: {
    CustomerId: ["CUST-456"],
  },
});
```

## Getting Workflow Handle

Get a handle to an existing workflow:

```typescript
const handleResult = await client.getHandle("processOrder", "order-123");

handleResult.match({
  ok: async (handle) => {
    // Query the workflow
    const statusResult = await handle.queries.getStatus({});
    statusResult.match({
      ok: (status) => console.log("Status:", status),
      errCases: (matcher) =>
        matcher.with(
          tag("@temporal-contract/QueryValidationError"),
          tag("@temporal-contract/WorkflowExecutionNotFoundError"),
          (error) => console.error("Query failed:", error),
        ),
      defect: (cause) => console.error("Unexpected failure:", cause),
    });

    // Signal the workflow
    const signalResult = await handle.signals.cancelOrder({ reason: "Customer request" });
    signalResult.match({
      ok: () => console.log("Signal sent"),
      errCases: (matcher) =>
        matcher.with(
          tag("@temporal-contract/SignalValidationError"),
          tag("@temporal-contract/WorkflowExecutionNotFoundError"),
          (error) => console.error("Signal failed:", error),
        ),
      defect: (cause) => console.error("Unexpected failure:", cause),
    });

    // Get the result
    const result = await handle.result();
    result.match({
      ok: (output) => console.log("Result:", output),
      errCases: (matcher) =>
        matcher.with(
          tag("@temporal-contract/ContractError"),
          tag("@temporal-contract/WorkflowValidationError"),
          tag("@temporal-contract/WorkflowFailedError"),
          tag("@temporal-contract/WorkflowExecutionNotFoundError"),
          (error) => console.error("Workflow failed:", error),
        ),
      defect: (cause) => console.error("Unexpected failure:", cause),
    });
  },
  errCases: (matcher) =>
    matcher.with(tag("@temporal-contract/WorkflowNotFoundError"), (error) =>
      console.error("Failed to get handle:", error),
    ),
  defect: (cause) => console.error("Unexpected failure:", cause),
});
```

## Multiple Workflows

The same client can execute any workflow in the contract:

```typescript
const orderResult = await client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: { orderId: "ORD-123", customerId: "CUST-456" },
});

const refundResult = await client.executeWorkflow("processRefund", {
  workflowId: "refund-123",
  args: { orderId: "ORD-123", reason: "Damaged item" },
});
```

## Error Handling

### Workflow Execution Errors

```typescript
const result = await client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: { orderId: "ORD-123", customerId: "CUST-456" },
});

result.match({
  ok: (value) => console.log("Success:", value),
  errCases: (matcher) =>
    matcher.with(
      tag("@temporal-contract/ContractError"),
      tag("@temporal-contract/WorkflowNotFoundError"),
      tag("@temporal-contract/WorkflowValidationError"),
      tag("@temporal-contract/WorkflowAlreadyStartedError"),
      tag("@temporal-contract/WorkflowFailedError"),
      tag("@temporal-contract/WorkflowExecutionNotFoundError"),
      (error) => console.error("Workflow returned error:", error),
    ),
  defect: (cause) => console.error("Unexpected failure:", cause),
});
```

### Workflow Failures

```typescript
import { WorkflowFailedError } from "@temporalio/client";

try {
  await client.executeWorkflow("processOrder", {
    workflowId: "order-123",
    args: { orderId: "ORD-123", customerId: "CUST-456" },
  });
} catch (error) {
  if (error instanceof WorkflowFailedError) {
    console.error("Workflow failed:", error.message);
    console.error("Cause:", error.cause);
  }
}
```

### Typed Contract Errors

When a workflow declares an `errors` map on the contract, a failed execution
whose failure matches a declared error surfaces as a typed, schema-validated
`ContractError` on the `err` channel — instead of the generic
`WorkflowFailedError`:

```typescript
import { ContractError } from "@temporal-contract/client";

const result = await client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: { orderId: "ORD-123", customerId: "CUST-456" },
});

if (result.isErr() && result.error instanceof ContractError) {
  switch (result.error.errorName) {
    case "EmptyOrder":
      // result.error.data is typed from the declared schema
      console.warn("Nothing to process for", result.error.data.orderId);
      break;
  }
}
```

Failures that don't match a declared error (unknown type, payload that no
longer validates) fall back to `WorkflowFailedError`, so a contract mismatch
degrades to the untyped behavior rather than producing a wrong typed error.
The same rehydration applies to `handle.result()`.

## Interceptors

`TypedClient.create` accepts client-side `interceptors` wrapping
`startWorkflow` / `executeWorkflow` / `signalWithStart` and handle-level
`signal` / `query` / `update`, outermost-first. Interceptors run _outside_
the validation pipeline — a patched input is validated exactly like the
caller's original — and are the seam for trace propagation, observability,
and retries:

```typescript
import type { ClientInterceptor } from "@temporal-contract/client";

// Observe every operation
const logging: ClientInterceptor = (args, next) =>
  next().tapErrCases((matcher) =>
    matcher.with(
      tag("@temporal-contract/WorkflowNotFoundError"),
      tag("@temporal-contract/WorkflowValidationError"),
      tag("@temporal-contract/WorkflowAlreadyStartedError"),
      tag("@temporal-contract/WorkflowFailedError"),
      tag("@temporal-contract/WorkflowExecutionNotFoundError"),
      tag("@temporal-contract/SignalValidationError"),
      tag("@temporal-contract/QueryValidationError"),
      tag("@temporal-contract/UpdateValidationError"),
      tag("@temporal-contract/ContractError"),
      (error) => {
        logger.warn({ operation: args.operation, workflowId: args.workflowId, error });
      },
    ),
  );

// Retry a transient failure once. Transient technical faults (an unrecognized
// Temporal rejection, a dropped connection) ride the defect channel now, so the
// retry re-enters via `recoverDefect` — a defect is the retry signal, and any
// genuinely-modeled `Err` still flows through untouched.
const retryOnce: ClientInterceptor = (args, next) => next().recoverDefect(() => next());

// `create` returns AsyncResult<TypedClient, never> — its only failures are
// defects, so `get()` (not `getOrThrow()`) is the extractor; it panics
// (rethrowing the defect's TechnicalError cause) if setup failed.
const client = await TypedClient.create({
  contract: myContract,
  client: temporalClient,
  interceptors: [logging, retryOnce],
}).get();
```

An interceptor can also patch the invocation (`next({ input })`) or
short-circuit by returning its own `AsyncResult` without calling `next`.

## Connection Management

### Single Connection

Reuse connections across clients:

```typescript
const connection = await Connection.connect({
  address: "localhost:7233",
});

const temporalClient = new Client({ connection });

const orderClient = await TypedClient.create({
  contract: orderContract,
  client: temporalClient,
}).get();
const inventoryClient = await TypedClient.create({
  contract: inventoryContract,
  client: temporalClient,
}).get();

// Both clients share the same connection and Temporal client instance
```

### Connection Pooling

For high-throughput applications:

```typescript
const connection = await Connection.connect({
  address: "localhost:7233",
  // Connection pool settings
  maxConcurrentWorkflowTaskPollers: 10,
  maxConcurrentActivityTaskPollers: 20,
});
```

### Closing Connections

```typescript
// Close connection when done
await connection.close();
```

## Working with Multiple Contracts

Different clients for different contracts:

```typescript
import { orderContract } from "./contracts/order.js";
import { paymentContract } from "./contracts/payment.js";
import { inventoryContract } from "./contracts/inventory.js";

const temporalClient = new Client({ connection });

const orderClient = await TypedClient.create({
  contract: orderContract,
  client: temporalClient,
}).get();
const paymentClient = await TypedClient.create({
  contract: paymentContract,
  client: temporalClient,
}).get();
const inventoryClient = await TypedClient.create({
  contract: inventoryContract,
  client: temporalClient,
}).get();

// Each client is typed to its contract
await orderClient.executeWorkflow("processOrder", {/* ... */});
await paymentClient.executeWorkflow("processPayment", {/* ... */});
await inventoryClient.executeWorkflow("updateStock", {/* ... */});
```

## Testing

Mock the client for testing:

```typescript
import { describe, it, expect, vi } from "vitest";
import { Ok } from "unthrown";

describe("OrderService", () => {
  it("should process order", async () => {
    const mockClient = {
      executeWorkflow: vi
        .fn()
        .mockResolvedValue(Ok({ status: "success", transactionId: "tx-123" })),
    };

    const service = new OrderService(mockClient);
    const result = await service.createOrder({
      orderId: "ORD-123",
      customerId: "CUST-456",
    });

    expect(mockClient.executeWorkflow).toHaveBeenCalledWith(
      "processOrder",
      expect.objectContaining({
        args: { orderId: "ORD-123", customerId: "CUST-456" },
      }),
    );
  });
});
```

## Best Practices

### 1. Reuse Connections

```typescript
// ✅ Good - single connection
const connection = await Connection.connect({ address: "localhost:7233" });
const temporalClient = new Client({ connection });
const client = await TypedClient.create({
  contract: contract,
  client: temporalClient,
}).get();

// ❌ Avoid - creating connections repeatedly
for (const order of orders) {
  const connection = await Connection.connect({ address: "localhost:7233" });
  const temporalClient = new Client({ connection });
  const client = await TypedClient.create({
    contract: contract,
    client: temporalClient,
  }).get();
  await client.executeWorkflow(/* ... */);
}
```

### 2. Use Meaningful Workflow IDs

```typescript
// ✅ Good - descriptive and unique
workflowId: `order-${orderId}-${Date.now()}`;

// ❌ Avoid - random or non-descriptive
workflowId: Math.random().toString();
```

### 3. Handle Both Success and Error Cases

```typescript
// ✅ Good - handle all cases
const result = await client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: { orderId: "ORD-123", customerId: "CUST-456" },
});

result.match({
  ok: (value) => {
    // Handle success
    updateDatabase(value);
  },
  errCases: (matcher) =>
    matcher.with(
      tag("@temporal-contract/ContractError"),
      tag("@temporal-contract/WorkflowNotFoundError"),
      tag("@temporal-contract/WorkflowValidationError"),
      tag("@temporal-contract/WorkflowAlreadyStartedError"),
      tag("@temporal-contract/WorkflowFailedError"),
      tag("@temporal-contract/WorkflowExecutionNotFoundError"),
      (error) => {
        // Handle error
        logError(error);
        notifySupport(error);
      },
    ),
  defect: (cause) => {
    // Handle unexpected failure (bug)
    logError(cause);
    notifySupport(cause);
  },
});
```

## See Also

- [Defining Contracts](/guide/defining-contracts) - Creating your contract definitions
- [Worker Usage](/guide/worker-usage) - Implementing workflows and activities
- [Result Pattern](/guide/result-pattern) - Understanding Result/AsyncResult error handling
- [API Reference](/api/client) - Complete client API documentation
