# Temporal Nexus Integration

::: warning Work in Progress
Nexus support in temporal-contract is **planned but not yet implemented**. This page documents the future integration design and how to use Nexus with the current Temporal SDK.
:::

## Overview

Temporal Nexus enables durable, cross-namespace workflow orchestration. It allows independent Temporal applications in isolated namespaces to communicate reliably and securely through well-defined service contracts.

## What is Nexus?

Nexus is a Temporal feature that provides:

- **Cross-namespace Communication** - Invoke operations across namespace boundaries
- **Service Contracts** - Define clear API boundaries between teams
- **Durability** - Inherits Temporal's reliability and fault-tolerance
- **Security** - Fine-grained access control and isolation
- **Decoupling** - Teams can evolve services independently

## Use Cases

### Microservice Orchestration

Coordinate workflows across team boundaries while maintaining isolation:

```
Orders Service ──> [Nexus] ──> Payment Service
                            └──> Inventory Service
```

### Multi-tenant Systems

Isolate tenant data while enabling cross-tenant operations when needed.

### Cross-region Workflows

Orchestrate workflows that span multiple regions or cloud providers.

### API Abstraction

Hide implementation details behind stable, versioned service contracts.

## Current Status

**Temporal SDK Support**: ✅ Available (experimental)  
**temporal-contract Support**: ⏳ Planned for v0.5.0

## Using Nexus Today

You can use Nexus with the raw Temporal SDK while waiting for temporal-contract integration:

### 1. Define a Nexus Service

```typescript
// payment-service/nexus.ts
export const paymentService = {
  name: "PaymentService",
  operations: {
    processPayment: async (ctx, input: { amount: number; customerId: string }) => {
      // Implementation
      return {
        transactionId: crypto.randomUUID(),
        status: "success" as const,
      };
    },
  },
};
```

### 2. Register with Worker

```typescript
// payment-service/worker.ts
import { Worker } from "@temporalio/worker";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { paymentService } from "./nexus.js";

const worker = await Worker.create({
  taskQueue: "payments",
  nexusServices: [paymentService],
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities,
});
```

### 3. Invoke from Another Service

```typescript
// order-service/workflows.ts
import { nexus } from "@temporalio/workflow";

export async function processOrderWorkflow(order: Order) {
  // Call payment service in different namespace
  const payment = await nexus.invoke("PaymentService", "processPayment", {
    amount: order.total,
    customerId: order.customerId,
  });

  if (payment.status === "success") {
    // Continue order processing
  }
}
```

::: tip
See [Temporal Nexus documentation](https://docs.temporal.io/develop/typescript/nexus) for complete SDK details.
:::

## Future: temporal-contract Integration

The goal is to bring type safety and validation to Nexus operations:

### Proposed Contract API

```typescript
import { defineContract } from "@temporal-contract/contract";
import { z } from "zod";

export const paymentContract = defineContract({
  taskQueue: "payments",

  workflows: {
    // ... existing workflows
  },

  // New: Nexus service definitions
  nexusServices: {
    PaymentService: {
      operations: {
        processPayment: {
          input: z.object({
            amount: z.number().positive(),
            customerId: z.string().uuid(),
          }),
          output: z.object({
            transactionId: z.string(),
            status: z.enum(["success", "failed"]),
          }),
        },
      },
    },
  },
});
```

### Proposed Handler API

```typescript
import { createNexusHandlers } from "@temporal-contract/worker";

export const nexusHandlers = createNexusHandlers(paymentContract, {
  PaymentService: {
    processPayment: async ({ amount, customerId }) => {
      // ✅ Input automatically validated
      // ✅ Fully typed parameters

      const payment = await processPayment(customerId, amount);

      // ✅ Return value validated against schema
      return {
        transactionId: payment.id,
        status: "success",
      };
    },
  },
});
```

### Proposed Client API

```typescript
import { createNexusClient } from "@temporal-contract/client";

const nexusClient = createNexusClient<typeof paymentContract>(connection, {
  namespace: "payments-ns",
});

// ✅ Fully typed invocation
const result = await nexusClient.invoke("PaymentService", "processPayment", {
  amount: 100,
  customerId: "cust-123",
});

// ❌ TypeScript error - caught at compile time
await nexusClient.invoke("PaymentService", "processPayment", {
  amount: -50, // Error: must be positive
  customerId: "invalid", // Error: must be UUID
});
```

## Benefits of Integration

| Feature       | Without temporal-contract | With temporal-contract      |
| ------------- | ------------------------- | --------------------------- |
| Type Safety   | ❌ Manual types           | ✅ Automatic from schemas   |
| Validation    | ❌ Manual checks          | ✅ Automatic Zod validation |
| Autocomplete  | ⚠️ Limited                | ✅ Full IDE support         |
| Refactoring   | ❌ Manual updates         | ✅ Compile-time checks      |
| Documentation | ❌ Separate               | ✅ Types as docs            |

## Architecture

Future Nexus support will follow temporal-contract's existing patterns:

```
┌─────────────────────────────────────────────────────────┐
│ Contract Definition (Single Source of Truth)            │
│  - Workflows                                             │
│  - Activities                                            │
│  - Nexus Services ← NEW                                  │
└─────────────────────────────────────────────────────────┘
                      │
          ┌───────────┴───────────┐
          ▼                       ▼
┌──────────────────┐    ┌──────────────────┐
│ Worker Package   │    │ Client Package   │
│  - Workflows     │    │  - Typed calls   │
│  - Activities    │    │  - Validation    │
│  - Nexus Handlers│    │  - Nexus client  │
└──────────────────┘    └──────────────────┘
```

## Implementation Timeline

Planned for v0.5.0:

- [ ] Core type definitions for Nexus operations
- [ ] Worker integration with validation
- [ ] Client integration with type safety
- [ ] Documentation and examples
- [ ] Sample projects

## Resources

### Official Documentation

- [Temporal Nexus Overview](https://docs.temporal.io/nexus)
- [TypeScript Nexus Guide](https://docs.temporal.io/develop/typescript/nexus)
- [Nexus API Reference](https://typescript.temporal.io/api/namespaces/nexus)

### Examples

- [nexus-hello sample](https://github.com/temporalio/samples-typescript/tree/main/nexus-hello)
- [nexus-cancellation sample](https://github.com/temporalio/samples-typescript/tree/main/nexus-cancellation)

### Articles

- [Announcing Nexus](https://temporal.io/blog/announcing-nexus-connect-temporal-applications-across-isolated-namespaces)
- [Is Temporal Nexus Right for Your Project?](https://www.bitovi.com/blog/is-temporal-nexus-the-right-choice-for-your-project)

## Contributing

Want to help implement Nexus support?

1. Review [CONTRIBUTING.md](https://github.com/btravstack/temporal-contract/blob/main/CONTRIBUTING.md)
2. Join the discussion in [GitHub Issues](https://github.com/btravstack/temporal-contract/issues)

## Feedback

Have suggestions for the Nexus integration design? Please open an issue or discussion!

::: info Next Steps

- Learn about [Core Concepts](/guide/core-concepts)
- Explore [Worker Implementation](/guide/worker-implementation)
- See [Activity Handlers](/guide/activity-handlers)
  :::
