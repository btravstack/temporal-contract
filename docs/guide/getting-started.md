# Getting Started

Welcome to **temporal-contract**! This guide will help you get up and running with type-safe Temporal workflows.

## What is temporal-contract?

**temporal-contract** is a TypeScript library that brings end-to-end type safety and automatic validation to [Temporal.io](https://temporal.io/) workflows and activities. It uses a contract-first approach with Standard Schema compatible libraries (Zod, Valibot, ArkType) to ensure your workflows are type-safe from definition to execution.

## Why Use temporal-contract?

### The Problem

Working with Temporal.io is powerful, but comes with challenges:

- **No type safety** — Workflow parameters and return types are loosely typed
- **Manual validation** — You need to validate inputs and outputs manually
- **Runtime errors** — Type mismatches are only caught at runtime
- **Scattered definitions** — Activity types are defined separately from workflows

### The Solution

temporal-contract solves these problems by:

- ✅ **End-to-end type safety** — From contract to client, workflows, and activities
- ✅ **Automatic validation** — Standard Schema (Zod, Valibot, ArkType) validates at all network boundaries
- ✅ **Compile-time checks** — TypeScript catches issues before runtime
- ✅ **Better DX** — Autocomplete, refactoring support, inline documentation

## Installation

Install the required packages:

::: code-group

```bash [pnpm]
pnpm add @temporal-contract/contract @temporal-contract/worker @temporal-contract/client unthrown
pnpm add zod @temporalio/client @temporalio/worker @temporalio/workflow
```

```bash [npm]
npm install @temporal-contract/contract @temporal-contract/worker @temporal-contract/client unthrown
npm install zod @temporalio/client @temporalio/worker @temporalio/workflow
```

```bash [yarn]
yarn add @temporal-contract/contract @temporal-contract/worker @temporal-contract/client unthrown
yarn add zod @temporalio/client @temporalio/worker @temporalio/workflow
```

:::

## Quick Start

Let's build a simple order processing workflow in 3 steps.

```mermaid
graph LR
    A[1. Define Contract] --> B[2. Implement Activities & Workflows]
    B --> C[3. Start Worker & Client]

    style A fill:#3b82f6,stroke:#1e40af,color:#fff
    style B fill:#10b981,stroke:#059669,color:#fff
    style C fill:#8b5cf6,stroke:#6d28d9,color:#fff
```

### 1. Define Your Contract

Create a contract that defines your workflow's interface:

```typescript
// contract.ts
import { defineContract } from "@temporal-contract/contract";
import { z } from "zod";

export const orderContract = defineContract({
  taskQueue: "orders",

  // Global activities available to all workflows
  activities: {
    sendEmail: {
      input: z.object({
        to: z.string().email(),
        subject: z.string(),
        body: z.string(),
      }),
      output: z.object({ sent: z.boolean() }),
    },
  },

  workflows: {
    processOrder: {
      input: z.object({
        orderId: z.string(),
        customerId: z.string(),
      }),
      output: z.object({
        status: z.enum(["success", "failed"]),
        transactionId: z.string(),
      }),

      // Workflow-specific activities
      activities: {
        processPayment: {
          input: z.object({
            customerId: z.string(),
            amount: z.number().positive(),
          }),
          output: z.object({
            transactionId: z.string(),
            success: z.boolean(),
          }),
        },
      },
    },
  },
});
```

### 2. Implement Activities & Workflows

Implement your activities and workflows with full type safety:

```typescript
// activities.ts
import { declareActivitiesHandler, qualify } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";
import { orderContract } from "./contract.js";

export const activities = declareActivitiesHandler({
  contract: orderContract,
  activities: {
    sendEmail: ({ to, subject, body }) =>
      // Full type safety - parameters are automatically typed!
      // `qualify` wraps a rejection in an ApplicationFailure of that type.
      fromPromise(emailService.send({ to, subject, body }), qualify("EMAIL_FAILED")).map(() => ({
        sent: true,
      })),
    processPayment: ({ customerId, amount }) =>
      // TypeScript knows the exact types
      fromPromise(paymentGateway.charge(customerId, amount), qualify("PAYMENT_FAILED")).map(
        (txId) => ({ transactionId: txId, success: true }),
      ),
  },
});
```

```typescript
// workflows.ts
import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { orderContract } from "./contract.js";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, args) => {
    // Full autocomplete for activities and their parameters
    // Activities return plain values (Result is unwrapped internally)
    const payment = await context.activities.processPayment({
      customerId: args.customerId,
      amount: 100,
    });

    await context.activities.sendEmail({
      to: args.customerId,
      subject: "Order Confirmed",
      body: `Order ${args.orderId} processed`,
    });

    // Return plain object (not Result - network serialization requirement)
    return {
      status: payment.success ? "success" : "failed",
      transactionId: payment.transactionId,
    };
  },
});
```

### 3. Start Worker & Call from Client

Set up your worker and client:

```typescript
// worker.ts
import { NativeConnection } from "@temporalio/worker";
import { createWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { orderContract } from "./contract.js";
import { activities } from "./activities.js";

const connection = await NativeConnection.connect({
  address: "localhost:7233",
});

const worker = await createWorker({
  contract: orderContract, // the task queue comes from the contract
  connection,
  // ESM-safe path resolution (there is no `require.resolve` in ESM)
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities,
});

await worker.run();
```

```typescript
// client.ts
import { TypedClient } from "@temporal-contract/client";
import { Connection, Client } from "@temporalio/client";
import { orderContract } from "./contract.js";

const connection = await Connection.connect({
  address: "localhost:7233",
});

const temporalClient = new Client({ connection });
const client = TypedClient.create(orderContract, temporalClient);

// Fully typed workflow execution with Result/AsyncResult pattern
const resultAsync = client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: { orderId: "ORD-123", customerId: "CUST-456" },
});

const result = await resultAsync;

result.match({
  ok: (output) => {
    console.log(output.status); // 'success' | 'failed' — fully typed!
  },
  err: (error) => {
    console.error("Workflow failed:", error);
  },
  defect: (cause) => {
    console.error("Unexpected failure:", cause);
  },
});
```

## What's Next?

- 📚 Learn about [Core Concepts](/guide/core-concepts)
- 🔨 Explore [Worker Implementation](/guide/worker-implementation)
- 📖 Check out [Examples](/examples/)
- 🔍 Browse the [API Reference](/api/)
