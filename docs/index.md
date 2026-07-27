---
layout: home
title: temporal-contract - Type-safe Temporal.io workflows for TypeScript
description: End-to-end type safety, runtime validation, and explicit error handling for Temporal.io workflows and activities in TypeScript

hero:
  name: "temporal-contract"
  text: "Type-safe contracts for Temporal.io"
  tagline: End-to-end type safety · Runtime validation · Explicit error handling
  image:
    light: /logo-light.svg
    dark: /logo-dark.svg
    alt: temporal-contract
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Why temporal-contract?
      link: /guide/why-temporal-contract
    - theme: alt
      text: GitHub
      link: https://github.com/btravstack/temporal-contract

features:
  - icon: { src: /icons/shield-check.svg }
    title: Type Safety & Validation
    details: End-to-end TypeScript inference with automatic runtime validation using Zod, Valibot, or ArkType.

  - icon: { src: /icons/target.svg }
    title: Explicit Error Handling
    details: Result/AsyncResult pattern from unthrown for workflows that need explicit error handling without exceptions.

  - icon: { src: /icons/contract.svg }
    title: Contract-First Design
    details: Define your workflow interface once — types and validation flow from contract to client and worker.
---

## Quick Example

Define your contract once — get type safety everywhere:

::: code-group

```typescript [1. Define Contract]
import { defineContract } from "@temporal-contract/contract";
import { z } from "zod";

export const orderContract = defineContract({
  taskQueue: "orders",
  workflows: {
    processOrder: {
      input: z.object({
        orderId: z.string(),
        customerId: z.string(),
        amount: z.number(),
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
        sendNotification: {
          input: z.object({ customerId: z.string(), message: z.string() }),
          output: z.void(),
        },
      },
    },
  },
});
```

```typescript [2. Implement Activities]
import { fromPromise } from "unthrown";
import { declareActivitiesHandler, ApplicationFailure } from "@temporal-contract/worker/activity";
import { orderContract } from "./contract.js";

export const activities = declareActivitiesHandler({
  contract: orderContract,
  activities: {
    processOrder: {
      processPayment: ({ customerId, amount }) =>
        fromPromise(paymentService.charge(customerId, amount), (e) =>
          ApplicationFailure.create({
            type: "PAYMENT_FAILED",
            message: e instanceof Error ? e.message : "Payment failed",
            cause: e instanceof Error ? e : undefined,
          }),
        ).map((tx) => ({ transactionId: tx.id })),
      sendNotification: ({ customerId, message }) =>
        fromPromise(notificationService.send(customerId, message), (e) =>
          ApplicationFailure.create({
            type: "NOTIFICATION_FAILED",
            message: e instanceof Error ? e.message : "Notification failed",
            cause: e instanceof Error ? e : undefined,
          }),
        ),
    },
  },
});
```

```typescript [3. Implement Workflow]
import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { orderContract } from "./contract.js";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async ({ activities }, { orderId, customerId, amount }) => {
    const { transactionId } = await activities.processPayment({ customerId, amount });
    await activities.sendNotification({ customerId, message: `Order ${orderId} confirmed!` });
    return { status: "success", transactionId };
  },
});
```

```typescript [4. Call from Client]
import { TypedClient } from "@temporal-contract/client";
import { Connection, Client } from "@temporalio/client";
import { orderContract } from "./contract.js";

const connection = await Connection.connect({ address: "localhost:7233" });
const temporalClient = new Client({ connection });
const client = await TypedClient.create({
  contract: orderContract,
  client: temporalClient,
}).getOrThrow();

const future = client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: { orderId: "ORD-123", customerId: "CUST-456", amount: 99.99 },
});

const result = await future;

result.match({
  ok: (output) => console.log(output.status), // ✅ 'success' | 'failed'
  errCases: (matcher) =>
    matcher.with(
      tag("@temporal-contract/ContractError"),
      tag("@temporal-contract/WorkflowNotFoundError"),
      tag("@temporal-contract/WorkflowValidationError"),
      tag("@temporal-contract/WorkflowAlreadyStartedError"),
      tag("@temporal-contract/WorkflowFailedError"),
      tag("@temporal-contract/WorkflowExecutionNotFoundError"),
      tag("@temporal-contract/RuntimeClientError"),
      (error) => console.error("Failed:", error),
    ),
  defect: (cause) => console.error("Unexpected:", cause),
});
```

:::
