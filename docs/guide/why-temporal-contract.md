---
title: Why temporal-contract? - Type-safe Temporal.io Workflows for TypeScript
description: Discover why temporal-contract is the best solution for building type-safe Temporal.io workflows and activities with TypeScript and Node.js. Learn about contract-first development and schema validation.
---

# Why temporal-contract?

Working with [Temporal.io](https://temporal.io/) is powerful for building durable applications, but it comes with significant challenges when building TypeScript applications. **temporal-contract** solves these problems by bringing a contract-first, type-safe approach to Temporal workflows.

## The Problem

Traditional Temporal development in TypeScript lacks type safety and validation, leading to several issues:

### 1. No Type Safety

Without types, you're working blind:

```typescript
// ❌ Traditional approach - no type safety
const result = await client.workflow.execute("processOrder", {
  workflowId: "order-123",
  taskQueue: "orders",
  args: [{ orderId: "ORD-123" }], // What fields are required? What types?
});

console.log(result.status); // unknown type, no autocomplete
// Is it status or state? Did the field change?
```

### 2. Manual Validation Everywhere

You must validate inputs manually at every boundary:

```typescript
// ❌ Validation scattered throughout the codebase
function validateOrderInput(data: unknown): OrderInput {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid data");
  }
  const order = data as any;
  if (typeof order.orderId !== "string") {
    throw new Error("orderId must be a string");
  }
  // ... dozens more checks ...
  return order as OrderInput;
}
```

### 3. Runtime Errors from Wrong Data

Without validation, invalid inputs cause runtime failures:

```typescript
// ❌ No validation - crashes at runtime
export async function processOrder(input: unknown): Promise<OrderResult> {
  const order = input as OrderInput;
  await activities.processPayment(order.amount); // TypeError: amount is undefined
}
```

### 4. Scattered Activity Definitions

Activity schemas are duplicated across services:

```typescript
// ❌ Duplicated types in multiple files
// workflow.ts
interface PaymentResult {
  transactionId: string;
  status: string;
}

// activities.ts
interface PaymentResult {
  // Same type, different file
  transactionId: string;
  status: string;
}
```

### 5. Difficult Refactoring

Changing a workflow schema means hunting through multiple files:

```typescript
// ❌ Change orderId to id - must update everywhere manually
// No compile-time checks to catch all usages
```

## The Solution

**temporal-contract** transforms Temporal development with a contract-first approach:

### 1. End-to-End Type Safety

Define your contract once, get types everywhere:

```typescript
import { defineContract } from "@temporal-contract/contract";
import { TypedClient } from "@temporal-contract/client";
import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { declareActivitiesHandler } from "@temporal-contract/worker/activity";
import { z } from "zod";

// 1. Define contract
const contract = defineContract({
  taskQueue: "orders",
  workflows: {
    processOrder: {
      input: z.object({
        orderId: z.string(),
        customerId: z.string(),
        amount: z.number().positive(),
      }),
      output: z.object({
        status: z.enum(["success", "failed"]),
        transactionId: z.string().optional(),
      }),
      activities: {
        processPayment: {
          input: z.object({ customerId: z.string(), amount: z.number() }),
          output: z.object({ transactionId: z.string() }),
        },
      },
    },
  },
});

// 2. Client gets full type safety
const client = TypedClient.create(contract, temporalClient);

const future = client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: {
    orderId: "ORD-123", // ✅ TypeScript knows these fields!
    customerId: "CUST-456", // ✅ Autocomplete works!
    amount: 99.99, // ✅ Type checked at compile time!
  },
});

// 3. Workflow gets fully typed context
const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract,
  implementation: async ({ activities }, { orderId, customerId, amount }) => {
    const payment = await activities.processPayment({ customerId, amount });
    return { status: "success", transactionId: payment.transactionId };
  },
});
```

### 2. Automatic Validation

Schema validation happens automatically at network boundaries:

```typescript
// ✅ Validation happens automatically
const result = await client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: {
    orderId: "ORD-123",
    customerId: "CUST-456",
    amount: -10, // ❌ Validation error: amount must be positive
  },
});

result.match({
  ok: (output) => console.log("Success:", output),
  err: (error) => console.error("Validation failed:", error),
  defect: (cause) => console.error("Unexpected failure:", cause),
});
```

### 3. Compile-Time Checks

TypeScript catches errors before runtime:

```typescript
// ❌ TypeScript error at compile time
const future = client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: {
    orderId: "ORD-123",
    // Missing customerId and amount - TypeScript error!
  },
});

// ❌ TypeScript error for wrong types
const future = client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: {
    orderId: 123, // Error: orderId must be string
    customerId: "CUST-456",
    amount: 99.99,
  },
});
```

### 4. Single Source of Truth

Your contract is the single source of truth:

```typescript
// ✅ One contract definition
const contract = defineContract({
  taskQueue: "orders",
  workflows: {
    processOrder: {
      input: orderInputSchema,
      output: orderOutputSchema,
      activities: {
        processPayment: {
          input: paymentInputSchema,
          output: paymentOutputSchema,
        },
      },
    },
  },
});

// Client, workflow, and activities all use the same contract
// Types are guaranteed to be consistent!
```

### 5. Safe Refactoring

Refactoring is safe and guided by TypeScript:

```typescript
// Change the schema
const contract = defineContract({
  taskQueue: "orders",
  workflows: {
    processOrder: {
      input: z.object({
        id: z.string(), // Changed from orderId to id
        customerId: z.string(),
        amount: z.number().positive(),
      }),
      // ...
    },
  },
});

// TypeScript immediately shows all places that need updates:
// - Client calls
// - Workflow implementations
// - Activity handlers
```

## Key Benefits

### Better Developer Experience

- **Autocomplete** - Your IDE knows all workflow inputs and outputs
- **Inline Documentation** - Hover over fields to see schemas
- **Refactoring Support** - Rename fields safely across the codebase
- **Jump to Definition** - Navigate from usage to contract definition

### Compile-Time Safety

- **Catch Errors Early** - TypeScript catches issues before runtime
- **Type Inference** - No manual type annotations needed
- **Exhaustive Checks** - Ensure all activities are implemented

### Runtime Safety

- **Automatic Validation** - [Zod](https://zod.dev/), [Valibot](https://valibot.dev/), or [ArkType](https://arktype.io/) validate inputs
- **Explicit Error Handling** - Result types for predictable error handling
- **No Surprises** - Invalid inputs are caught at boundaries

### Maintainability

- **Single Source of Truth** - Contract defines everything
- **Clear Boundaries** - Well-defined workflow/activity interfaces
- **Version Control** - Track contract changes in git

## Inspired By

This project adapts the contract-first approach from:

- **[tRPC](https://trpc.io/)** - End-to-end type safety for RPC
- **[oRPC](https://orpc.dev/)** - Contract-first RPC with OpenAPI
- **[ts-rest](https://ts-rest.com/)** - Type-safe REST APIs

We've brought their excellent ideas to the world of [Temporal.io](https://temporal.io/) durable workflows.

## When to Use temporal-contract

**Perfect for:**

- ✅ TypeScript projects using Temporal.io
- ✅ Microservices with workflow orchestration
- ✅ Projects requiring strong type safety
- ✅ Teams that value developer experience
- ✅ Applications with complex workflow schemas

**Consider alternatives if:**

- ❌ You're not using TypeScript
- ❌ You need extremely low overhead (though validation overhead is minimal)
- ❌ You prefer dynamic, untyped workflows

## Next Steps

Ready to get started?

- **[Getting Started](/guide/getting-started)** - Install and create your first contract
- **[Core Concepts](/guide/core-concepts)** - Understand the fundamentals
- **[Examples](/examples/)** - See real-world usage patterns
