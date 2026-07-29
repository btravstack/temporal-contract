# Order Processing Contract

This package contains the contract definition for the order processing workflow.

## Purpose

This package is designed to be shared between:

- **Worker application**: Imports this package to implement workflows and activities
- **Client application**: Imports this package to consume the workflow from another application

## Architecture

```
┌─────────────────────────────────────┐
│   Contract Package (this package)   │
│   - Contract definition             │
│   - Domain schemas                  │
└─────────────────────────────────────┘
         ↑                    ↑
         │                    │
    ┌────┴────┐         ┌─────┴─────┐
    │ Worker  │         │  Client   │
    │ Package │         │  Package  │
    └─────────┘         └───────────┘
```

## What's included

- Contract definition (composition-first with the `define*` helpers):
  - `processOrder` workflow with workflow-local activities, signals
    (`approveOrder` with a payload, `cancelRequested` via the payload-less
    `defineSignal()` form), an argument-less `getOrderStatus` query
    (`defineQuery({ output })`), and a typed `PaymentDeclined` contract error
    declared on both the `processPayment` activity and the workflow
  - `cleanupExpiredOrders` — an activity-less workflow designed to run on a
    Temporal Schedule, using only the global `purgeExpiredOrders` activity
- Domain schemas (Order, PaymentResult, OrderStatus, etc.)

## Usage

### In Worker Application

```typescript
import { orderProcessingContract } from "@temporal-contract/sample-order-processing-contract";
import { declareWorkflow } from "@temporal-contract/worker/workflow";

// Implement the workflow
export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderProcessingContract,
  implementation: async (context, order) => {
    // ... implementation
  },
});
```

### In Client Application

```typescript
import { orderProcessingContract } from "@temporal-contract/sample-order-processing-contract";
import { TypedClient } from "@temporal-contract/client";

// Connection-scoped root — creation returns AsyncResult<_, never>; setup
// faults ride the defect channel (a TechnicalError cause), so `get()` panics
// (rethrowing that cause) on failure.
const typedClient = await TypedClient.create({
  client: new Client({ connection, namespace: "default" }),
}).get();

// Contract-scoped client — binding is synchronous, infallible, and memoized.
const orders = typedClient.for(orderProcessingContract);

// Start workflow with full type safety
const handleResult = await orders.startWorkflow("processOrder", {
  workflowId: order.orderId,
  args: order,
});
```

## Benefits

- **Separation of concerns**: Contract is independent of implementation
- **Reusability**: Can be imported by multiple applications
- **Type safety**: Full TypeScript support across boundaries
- **Versioning**: Contract can be versioned independently
