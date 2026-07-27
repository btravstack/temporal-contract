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

- Contract definition with workflow and activity signatures
- Domain schemas (Order, PaymentResult, etc.)

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
import {
  orderProcessingContract,
  Order,
} from "@temporal-contract/sample-order-processing-contract";
import { TypedClient } from "@temporal-contract/client";

// Create type-safe client — creation returns AsyncResult<_, never>; setup
// faults ride the defect channel (a TechnicalError cause), so `get()` panics
// (rethrowing that cause) on failure.
const client = await TypedClient.create({
  contract: orderProcessingContract,
  client: new Client({ connection, namespace: "default" }),
}).get();

// Start workflow with full type safety
const handle = await client.startWorkflow("processOrder", {
  workflowId: order.orderId,
  args: order,
});
```

## Benefits

- **Separation of concerns**: Contract is independent of implementation
- **Reusability**: Can be imported by multiple applications
- **Type safety**: Full TypeScript support across boundaries
- **Versioning**: Contract can be versioned independently
