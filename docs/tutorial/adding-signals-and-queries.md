# Adding signals, queries, and updates

[Your first workflow](/tutorial/your-first-workflow) built an order workflow
that runs start to finish without interruption. Real workflows rarely work that
way — they wait for approvals, report progress, and accept changes while
running.

In this tutorial you will make the same workflow interactive:

- a **query** to read the order's current status without disturbing it,
- a **signal** to approve the order and let it proceed,
- an **update** to change the amount before the charge happens.

Continue in the project you built. If you skipped ahead, do that tutorial first
— every file here is an edit to one you already have.

## The three mechanisms

They look similar and are easy to confuse, so before writing code:

|            | Sends data | Returns data | Waits for a reply                   | Use it to                             |
| ---------- | ---------- | ------------ | ----------------------------------- | ------------------------------------- |
| **Query**  | yes        | yes          | yes (immediately)                   | Read state. Must not modify anything. |
| **Signal** | yes        | no           | no                                  | Fire-and-forget notification.         |
| **Update** | yes        | yes          | yes (after the workflow handles it) | Change state and get confirmation.    |

A query is answered from the workflow's current in-memory state and must be
synchronous. A signal is delivered and forgotten. An update is a signal that
reports back.

## Step 1 — Declare them on the contract

Edit `src/contract.ts`. Add the three definitions and attach them to the
workflow:

```typescript
import {
  defineActivity,
  defineContract,
  defineQuery,
  defineSignal,
  defineUpdate,
  defineWorkflow,
} from "@temporal-contract/contract";
import { z } from "zod";

// ... chargeCard and sendReceipt as before ...

const getStatus = defineQuery({
  // No parameters — just omit `input`.
  output: z.object({
    state: z.enum(["awaiting-approval", "charging", "done"]),
    amount: z.number(),
  }),
});

const approve = defineSignal({
  input: z.object({
    approvedBy: z.string(),
  }),
});

const changeAmount = defineUpdate({
  input: z.object({
    amount: z.number().positive(),
  }),
  output: z.object({
    amount: z.number(),
  }),
});

const processOrder = defineWorkflow({
  input: z.object({
    orderId: z.string(),
    customerId: z.string(),
    amount: z.number().positive(),
  }),
  output: z.object({
    orderId: z.string(),
    transactionId: z.string(),
  }),
  activities: { chargeCard, sendReceipt },
  queries: { getStatus },
  signals: { approve },
  updates: { changeAmount },
});

export const orderContract = defineContract({
  taskQueue: "orders",
  workflows: { processOrder },
});
```

A signal has only `input` — there is nothing to return. Queries and updates
have both.

::: warning Queries (and update inputs) must validate synchronously
Temporal runs query handlers synchronously, so a query's schemas must validate
synchronously too — and so must an **update's input** schema, which feeds
Temporal's synchronous update validator. Plain Zod, Valibot, or ArkType object
schemas are fine; an async refinement (`z.string().refine(async ...)`) is not.
Standard Schema doesn't expose sync-vs-async at the type level, so the worker
probes the schema when the handler is bound and throws a `ContractMisuseError`
at bind time.
:::

## Step 2 — Handle them in the workflow

Edit `src/workflows.ts`. The workflow now holds mutable state, registers three
handlers, and waits for approval before charging:

```typescript
import { declareWorkflow, propagateActivityFailure } from "@temporal-contract/worker/workflow";
import { condition } from "@temporalio/workflow";

import { orderContract } from "./contract.js";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderContract,
  activityOptions: {
    startToCloseTimeout: "1 minute",
  },
  implementation: async (context, order) => {
    // Workflow-local state. Safe to mutate — Temporal replays the whole
    // function deterministically, so this reconstructs identically.
    let state: "awaiting-approval" | "charging" | "done" = "awaiting-approval";
    let amount = order.amount;
    let approvedBy: string | undefined;

    context.handleQuery("getStatus", () => ({ state, amount }));

    context.handleSignal("approve", (args) => {
      approvedBy = args.approvedBy;
    });

    context.handleUpdate("changeAmount", async (args) => {
      amount = args.amount;
      return { amount };
    });

    // Block until the approve signal arrives. `condition` is Temporal's
    // replay-safe wait primitive — never use a bare setTimeout or a polling
    // loop here.
    await condition(() => approvedBy !== undefined);

    state = "charging";

    const { transactionId } = await propagateActivityFailure(
      context.activities.chargeCard({
        customerId: order.customerId,
        amount,
      }),
    );

    await propagateActivityFailure(
      context.activities.sendReceipt({ customerId: order.customerId, transactionId }),
    );

    state = "done";

    return { orderId: order.orderId, transactionId };
  },
});
```

Points worth pausing on:

- **Handlers are registered inside the implementation**, not at module scope.
  That is what lets them close over `state`, `amount`, and `approvedBy`.
- **`context.handleQuery("getStatus", ...)`** is checked against the contract.
  Misspell the name and it is a compile error; the handler's argument and
  return types come from the contract's schemas.
- **The query handler is synchronous.** The update handler is `async`. That
  mirrors the table above and is enforced by the types.
- **`condition()`** comes from `@temporalio/workflow`. temporal-contract wraps
  the contract-shaped parts of Temporal, not all of it — the SDK's
  deterministic primitives are still yours to use directly.

Restart your worker so it picks up the new code.

## Step 3 — Drive it from the client

`executeWorkflow` starts a workflow and waits for the result, which is no good
when you need to interact mid-flight. Use `startWorkflow` instead: it returns a
**handle** as soon as the workflow starts.

Replace `src/client.ts`:

```typescript
import { tagPatterns, TypedClient, WORKFLOW_RESULT_ERROR_TAGS } from "@temporal-contract/client";
import { Client, Connection } from "@temporalio/client";

import { orderContract } from "./contract.js";

const connection = await Connection.connect({ address: "localhost:7233" });

const client = await TypedClient.create({
  client: new Client({ connection }),
}).get();

const started = await client.for(orderContract).startWorkflow("processOrder", {
  workflowId: `order-${Date.now()}`,
  args: {
    orderId: "ORD-2",
    customerId: "CUST-1",
    amount: 42.5,
  },
});

// `isOk()` narrows the Result. Note the shape: unthrown Results have THREE
// variants — Ok, Err, and Defect — so "not Err" is not the same as "Ok".
// Narrow on `isOk()` before touching `.value`.
if (!started.isOk()) {
  if (started.isErr()) {
    console.error("could not start:", started.error.message);
  } else {
    console.error("unexpected failure:", started.cause);
  }
  process.exit(1);
}

const handle = started.value;

// 1. Query the current state. The workflow is parked on `condition`.
//    (The payload argument is omittable — `getStatus` declares no input.)
const before = await handle.queries.getStatus();
console.log("status:", before.getOrThrow()); // { state: 'awaiting-approval', amount: 42.5 }

// 2. Update the amount and get confirmation back.
const updated = await handle.updates.changeAmount({ amount: 99.5 });
console.log("new amount:", updated.getOrThrow()); // { amount: 99.5 }

// 3. Signal approval. This unblocks the workflow.
//    Every handle call returns an AsyncResult, and `await` only collapses it
//    to a Result — it never throws. Unwrap it, or a failed delivery is
//    silently dropped and the workflow just never proceeds.
(await handle.signals.approve({ approvedBy: "ops@example.com" })).getOrThrow();

// 4. Now wait for the final result.
const result = await handle.result();

result.match({
  ok: (output) => console.log("charged:", output.transactionId),
  errCases: (matcher) =>
    matcher.with(
      // One arm for the whole result-phase union: validation, failure,
      // cancelled/terminated/timed out, and a missing execution.
      ...tagPatterns(WORKFLOW_RESULT_ERROR_TAGS),
      (error) => console.error("workflow failed:", error.message),
    ),
  defect: (cause) => console.error("unexpected:", cause),
});

await connection.close();
```

Run it:

```bash
npx tsx src/client.ts
```

```
status: { state: 'awaiting-approval', amount: 42.5 }
new amount: { amount: 99.5 }
charged: txn_CUST-1_9950
```

The transaction id ends in `9950`, not `4250` — the update landed before the
charge activity ran.

`handle.queries`, `handle.signals`, and `handle.updates` are generated from the
contract. Autocomplete lists exactly the operations this workflow declares, with
the right argument and return types. Every payload is validated before it is
sent and parsed by the worker on receive, so a transforming schema applies
exactly once.

## Step 4 — See a validation failure

Try an update the contract forbids:

```typescript
const rejected = await handle.updates.changeAmount({ amount: -5 });
if (rejected.isErr()) {
  console.log(rejected.error.message);
}
```

```
Validation failed for update "changeAmount" input
```

The workflow never saw it. `z.number().positive()` on the contract rejected the
call client-side, exactly as it did for workflow input in the first tutorial.

## What you learned

- Queries read, signals notify, updates change-and-confirm.
- They are declared on the contract and handled inside the workflow
  implementation, where they can close over workflow state.
- `startWorkflow` gives you a typed handle; `executeWorkflow` is the
  start-and-wait shortcut.
- Every payload crossing the boundary is validated against the contract.

## Next

- [Use signals, queries, and updates](/how-to/use-signals-queries-and-updates)
  — the recipe form, including handler draining and `signalWithStart`.
- [Model domain errors](/how-to/model-domain-errors) — replace generic failures
  with typed ones.
- [Client surface](/reference/client-surface) — everything a handle exposes.
