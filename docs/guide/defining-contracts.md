# Defining Contracts

Learn how to define type-safe contracts for your Temporal workflows and activities.

## Overview

Contracts are the foundation of temporal-contract. They define the interface for your workflows, including inputs, outputs, and activities, all using Standard Schema compatible libraries (Zod, Valibot, ArkType) for validation.

## Basic Contract Structure

**Composition-first: define resources individually, then compose them into
the contract.** Named resources are reusable across workflows and contracts,
get precise hover/jump-to-definition, and keep `defineContract` a readable
table of contents instead of a wall of inline literals.

```typescript
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

// Define resources first...
const log = defineActivity({
  input: z.object({
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
  }),
  output: z.void(),
});

const processPayment = defineActivity({
  input: z.object({
    userId: z.string(),
    amount: z.number(),
  }),
  output: z.object({
    transactionId: z.string(),
  }),
});

const myWorkflow = defineWorkflow({
  input: z.object({
    userId: z.string(),
    amount: z.number().positive(),
  }),
  output: z.object({
    success: z.boolean(),
    transactionId: z.string().optional(),
  }),
  // Workflow-specific activities
  activities: { processPayment },
});

// ...then compose the contract from references.
export const myContract = defineContract({
  taskQueue: "my-task-queue",
  // Global activities available to all workflows
  activities: { log },
  workflows: { myWorkflow },
});
```

## Contract Elements

### Task Queue

The task queue name that workers will listen on:

```typescript
taskQueue: "orders";
```

### Global Activities

Activities that are available to all workflows in the contract:

```typescript
activities: {
  sendEmail: {
    input: z.object({
      to: z.string().email(),
      subject: z.string(),
      body: z.string()
    }),
    output: z.object({ sent: z.boolean() }),
  },
}
```

### Workflows

Each workflow must define:

- `input`: Zod schema for workflow parameters
- `output`: Zod schema for workflow return value
- `activities`: Workflow-specific activities (optional)

```typescript
workflows: {
  processOrder: {
    input: z.object({ orderId: z.string() }),
    output: z.object({ status: z.string() }),
    activities: { /* ... */ }
  }
}
```

### Workflow-Specific Activities

Activities that are only available within a specific workflow:

```typescript
workflows: {
  processOrder: {
    // ...
    activities: {
      chargeCard: {
        input: z.object({ amount: z.number() }),
        output: z.object({ success: z.boolean() }),
      },
    },
  },
}
```

### Typed Errors

Activities and workflows can declare their domain failures on the contract.
The error name becomes the `ApplicationFailure.type` on the wire, `data` is a
Standard Schema for the structured payload (validated on both sides of the
boundary), and `nonRetryable` drives Temporal's retry policy from the
contract — so retry semantics ship with the contract instead of being
scattered across workers:

```typescript
workflows: {
  processOrder: {
    input: OrderSchema,
    output: OrderResultSchema,
    errors: {
      EmptyOrder: {
        data: z.object({ orderId: z.string() }),
        nonRetryable: true,
      },
    },
    activities: {
      processPayment: {
        input: z.object({ amount: z.number() }),
        output: PaymentResultSchema,
        errors: {
          PaymentDeclined: {
            data: z.object({ reason: z.string() }),
            message: "The payment was declined",
            nonRetryable: true, // permanent — Temporal stops retrying
          },
          GatewayUnavailable: {}, // data-less, retryable
        },
      },
    },
  },
}
```

Declared errors surface as typed, schema-validated `ContractError` values:
on the workflow side when calling the activity, and on the client side when
awaiting the workflow result. See
[Activity Handlers](/guide/activity-handlers) for producing them and
[Client Usage](/guide/client-usage) for consuming them.

### Default Activity Options

An activity can carry its default `ActivityOptions` (timeouts, retry policy)
on the contract, making operational behavior part of the shared source of
truth:

```typescript
activities: {
  sendNotification: {
    input: NotificationSchema,
    output: z.void(),
    defaultOptions: {
      startToCloseTimeout: "30 seconds",
      retry: { maximumAttempts: 5 },
    },
  },
}
```

Merge precedence at the worker, least → most specific:
`declareWorkflow`'s `activityOptions` (workflow-wide default) → the
activity's contract-level `defaultOptions` → `activityOptionsByName`
(explicit per-workflow override). Deployment-specific routing (`taskQueue`)
stays worker-side in `activityOptionsByName`.

## Schema Validation

All inputs and outputs are validated using Standard Schema compatible libraries (e.g., Zod):

```typescript
input: z.object({
  email: z.string().email(), // Email validation
  age: z.number().int().positive(), // Integer validation
  status: z.enum(["active", "inactive"]), // Enum validation
  metadata: z.record(z.string()).optional(), // Optional fields
});
```

## Type Inference

TypeScript automatically infers types from your schemas:

```typescript
const contract = defineContract({
  taskQueue: "orders",
  workflows: {
    processOrder: {
      input: z.object({
        orderId: z.string(),
        amount: z.number(),
      }),
      output: z.object({
        success: z.boolean(),
      }),
      activities: {},
    },
  },
});

// Types are automatically inferred:
// input: { orderId: string; amount: number }
// output: { success: boolean }
```

## Complex Schemas

Use Zod's full power for complex validations:

```typescript
const AddressSchema = z.object({
  street: z.string(),
  city: z.string(),
  zipCode: z.string().regex(/^\d{5}$/),
});

const OrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string(),
        quantity: z.number().int().positive(),
      }),
    )
    .min(1),
  shippingAddress: AddressSchema,
  billingAddress: AddressSchema.optional(),
  total: z.number().positive(),
});

export const orderContract = defineContract({
  taskQueue: "orders",
  workflows: {
    processOrder: {
      input: OrderSchema,
      output: z.object({
        orderId: z.string(),
        status: z.enum(["pending", "completed", "failed"]),
      }),
      activities: {},
    },
  },
});
```

## Reusable Schemas

Define schemas once and reuse them:

```typescript
const PaymentInput = z.object({
  amount: z.number().positive(),
  currency: z.enum(["USD", "EUR", "GBP"]),
});

const PaymentOutput = z.object({
  transactionId: z.string(),
  status: z.enum(["success", "failed"]),
});

export const contract = defineContract({
  taskQueue: "payments",
  workflows: {
    processPayment: {
      input: PaymentInput,
      output: PaymentOutput,
      activities: {
        chargeCard: {
          input: PaymentInput,
          output: PaymentOutput,
        },
      },
    },
  },
});
```

## Multiple Workflows

A contract can define multiple workflows:

```typescript
export const ecommerceContract = defineContract({
  taskQueue: "ecommerce",
  workflows: {
    processOrder: {
      input: z.object({ orderId: z.string() }),
      output: z.object({ success: z.boolean() }),
      activities: {
        /* ... */
      },
    },
    processRefund: {
      input: z.object({ orderId: z.string(), reason: z.string() }),
      output: z.object({ refunded: z.boolean() }),
      activities: {
        /* ... */
      },
    },
    updateInventory: {
      input: z.object({ productId: z.string(), delta: z.number() }),
      output: z.object({ newQuantity: z.number() }),
      activities: {
        /* ... */
      },
    },
  },
});
```

## Best Practices

### 1. Keep Contracts Focused

Group related workflows in the same contract:

```typescript
// ✅ Good - related workflows together
export const orderContract = defineContract({
  taskQueue: "orders",
  workflows: {
    createOrder: {
      /* ... */
    },
    cancelOrder: {
      /* ... */
    },
    updateOrder: {
      /* ... */
    },
  },
});

// ❌ Avoid - mixing unrelated workflows
export const contract = defineContract({
  taskQueue: "everything",
  workflows: {
    processOrder: {
      /* ... */
    },
    sendEmail: {
      /* ... */
    },
    generateReport: {
      /* ... */
    },
  },
});
```

### 2. Use Descriptive Names

```typescript
// ✅ Good - clear and descriptive
workflows: {
  processOrderPayment: { /* ... */ },
  cancelOrderAndRefund: { /* ... */ },
}

// ❌ Avoid - vague names
workflows: {
  process: { /* ... */ },
  handle: { /* ... */ },
}
```

### 3. Document Complex Schemas

```typescript
/**
 * Order processing workflow
 *
 * Handles the complete order lifecycle including:
 * - Payment processing
 * - Inventory reservation
 * - Shipping coordination
 */
processOrder: {
  input: z.object({
    orderId: z.string().describe('Unique order identifier'),
    customerId: z.string().describe('Customer UUID'),
    items: z.array(OrderItemSchema).describe('List of items to purchase'),
  }),
  // ...
}
```

## See Also

- [Client Usage](/guide/client-usage) - Using contracts with the client
- [Worker Usage](/guide/worker-usage) - Implementing contracts in workers
- [Core Concepts](/guide/core-concepts) - Understanding the contract-first approach
