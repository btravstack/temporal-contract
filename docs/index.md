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
      text: Your first workflow
      link: /tutorial/your-first-workflow
    - theme: alt
      text: Why temporal-contract?
      link: /explanation/why-temporal-contract
    - theme: alt
      text: GitHub
      link: https://github.com/btravstack/temporal-contract

features:
  - icon: { src: /icons/shield-check.svg }
    title: Validated at every boundary
    details: Schemas run on both sides of every network hop. A malformed call is rejected before a workflow is ever started — no history, no partial state.

  - icon: { src: /icons/target.svg }
    title: Failures as typed values
    details: Declare domain errors on the contract and handle them with an exhaustive matcher. A separate defect channel keeps genuine bugs loud instead of absorbed.

  - icon: { src: /icons/contract.svg }
    title: One definition, both sides
    details: Workflows, activities, signals, queries, updates, errors, and search attributes derive from a single contract the client and worker share.
---

## Define once, use everywhere

::: code-group

```typescript [1. Contract]
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

const chargeCard = defineActivity({
  input: z.object({ customerId: z.string(), amount: z.number().positive() }),
  output: z.object({ transactionId: z.string() }),
});

const processOrder = defineWorkflow({
  input: z.object({
    orderId: z.string(),
    customerId: z.string(),
    amount: z.number().positive(),
  }),
  output: z.object({ orderId: z.string(), transactionId: z.string() }),
  activities: { chargeCard },
});

export const orderContract = defineContract({
  taskQueue: "orders",
  workflows: { processOrder },
});
```

```typescript [2. Activities]
import { declareActivitiesHandler, qualify } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

import { orderContract } from "./contract.js";

export const activities = declareActivitiesHandler({
  contract: orderContract,
  activities: {
    // Workflow-scoped activities nest under their workflow, mirroring the contract.
    processOrder: {
      chargeCard: ({ customerId, amount }) =>
        fromPromise(gateway.charge(customerId, amount), qualify("CHARGE_FAILED")).map((charge) => ({
          transactionId: charge.id,
        })),
    },
  },
});
```

```typescript [3. Workflow]
import { declareWorkflow } from "@temporal-contract/worker/workflow";

import { orderContract } from "./contract.js";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, order) => {
    // `order` is typed from the contract. So is the return value.
    const { transactionId } = await context.activities.chargeCard({
      customerId: order.customerId,
      amount: order.amount,
    });

    return { orderId: order.orderId, transactionId };
  },
});
```

```typescript [4. Client]
import { TypedClient } from "@temporal-contract/client";
import { Client, Connection } from "@temporalio/client";
import { tag } from "unthrown";

import { orderContract } from "./contract.js";

const connection = await Connection.connect({ address: "localhost:7233" });

const client = await TypedClient.create({
  contract: orderContract,
  client: new Client({ connection }),
}).get();

const result = await client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: { orderId: "ORD-123", customerId: "CUST-456", amount: 99.99 },
});

result.match({
  ok: (output) => console.log(output.transactionId), // ✅ typed
  errCases: (matcher) =>
    matcher.with(
      tag("@temporal-contract/WorkflowNotFoundError"),
      tag("@temporal-contract/WorkflowValidationError"),
      tag("@temporal-contract/WorkflowAlreadyStartedError"),
      tag("@temporal-contract/WorkflowFailedError"),
      tag("@temporal-contract/WorkflowExecutionNotFoundError"),
      (error) => console.error("failed:", error.message),
    ),
  defect: (cause) => console.error("unexpected:", cause),
});
```

:::

## Where to start

| You want to…                     | Go to                                                |
| -------------------------------- | ---------------------------------------------------- |
| Build something end to end       | [Your first workflow](/tutorial/your-first-workflow) |
| Solve a specific problem         | [How-to guides](/how-to/install)                     |
| Look up an option or type        | [Reference](/reference/contract-surface)             |
| Understand why it works this way | [Explanation](/explanation/why-temporal-contract)    |
| Upgrade from 7.x                 | [Upgrade to v8](/how-to/upgrade-to-v8)               |

The documentation follows the [Diátaxis](https://diataxis.fr/) framework:
tutorials teach, how-to guides solve, reference describes, explanation
clarifies.
