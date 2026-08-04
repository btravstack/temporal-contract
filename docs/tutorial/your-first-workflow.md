# Your first workflow

In this tutorial you will build a working Temporal application from nothing: a
contract, two activities, a workflow, a worker, and a client that starts it.
By the end you will have run a real workflow against a real Temporal server and
seen a typed result come back.

This is a lesson, not a reference. Type the code as it appears — explanations of
_why_ each piece looks the way it does live in
[Explanation](/explanation/why-temporal-contract), and the exhaustive option
lists live in [Reference](/reference/contract-surface).

## What you need

- **Node.js ≥ 22.19**
- **A Temporal server** running on `localhost:7233`
- About 20 minutes

If you do not have a Temporal server yet, install the CLI and start one:

```bash
brew install temporal      # or: curl -sSf https://temporal.download/cli.sh | sh
temporal server start-dev
```

Leave that running. It serves gRPC on port 7233 and a Web UI on
<http://localhost:8233>, which you will use at the end to inspect your run.

## Step 1 — Create the project

```bash
mkdir order-app && cd order-app
npm init -y
npm pkg set type=module
```

Install temporal-contract and its peers:

```bash
npm install @temporal-contract/contract@beta @temporal-contract/worker@beta @temporal-contract/client@beta
npm install unthrown zod @temporalio/client @temporalio/common @temporalio/worker @temporalio/workflow
npm install -D typescript @types/node tsx
```

::: warning The `@beta` tag is required
temporal-contract 8.0 — the API this tutorial teaches — is currently a
prerelease published under the `beta` dist-tag. Without `@beta`, npm installs
the 7.x line, and the code in this tutorial will not match. The peers
(`unthrown`, `@temporalio/*`) and `zod` — this tutorial's pick of
[Standard Schema](https://standardschema.dev/) validator — are stable releases.
:::

Create a `tsconfig.json`. The two settings that matter are `module: nodenext`
(temporal-contract is ESM-only) and `strict` (the type inference depends on it):

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

## Step 2 — Write the contract

The contract is the one place your workflow's shape is defined. Everything else
— the worker, the client, the types, the runtime validation — is derived from
it.

Create `src/contract.ts`:

```typescript
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

// Define each resource on its own, then compose them.
const chargeCard = defineActivity({
  input: z.object({
    customerId: z.string(),
    amount: z.number().positive(),
  }),
  output: z.object({
    transactionId: z.string(),
  }),
});

const sendReceipt = defineActivity({
  input: z.object({
    customerId: z.string(),
    transactionId: z.string(),
  }),
  output: z.void(),
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
  // This workflow charges a card, so `retry-if-failed` blocks a second
  // *successful* run per order — Temporal's default (`allow-duplicate`)
  // would not. It does not guarantee no second charge: the mode permits a
  // retried start after ANY non-Completed close (Failed, Cancelled,
  // Terminated, or TimedOut), not only one where the charge never happened.
  // `sendReceipt` runs after `chargeCard` below, so exhausting its own
  // retries fails the run *after* the card was already charged, and a
  // retried start under the same order ID would re-enter `chargeCard`.
  // `once-per-id` would close that gap at the cost of a fresh order ID for
  // every retry — kept as `retry-if-failed` here to keep this first
  // tutorial's failure story to one activity (see Step 7).
  idempotency: "retry-if-failed",
  // Activities declared here are reachable only from this workflow.
  activities: { chargeCard, sendReceipt },
});

export const orderContract = defineContract({
  taskQueue: "orders",
  workflows: { processOrder },
});
```

Three things to notice:

- Each resource is a **named `const`**, and `defineContract` just references
  them. This keeps the contract readable and lets you reuse a resource across
  workflows.
- `defineWorkflow` takes `input` and `output` schemas. Any
  [Standard Schema](https://standardschema.dev/) library works — Zod here, but
  Valibot and ArkType are equally valid.
- `taskQueue` lives on the contract, so neither the worker nor the client has to
  repeat it.
- `idempotency` is required on every workflow — it is what stops a retried
  start from re-running a workflow that already finished. See [Define a
  contract](/how-to/define-a-contract#declare-idempotency) for the three
  modes and why the field exists.

`defineContract` validates this structure the moment it runs. Misspell a key,
pass something that isn't a schema, or give two activities the same name, and
you get an error at import time rather than a puzzling failure in production.

## Step 3 — Implement the activities

Activities are where side effects live: HTTP calls, database writes, anything
non-deterministic. In temporal-contract they return an `AsyncResult` from
[unthrown](https://github.com/btravstack/unthrown) instead of throwing.

Create `src/activities.ts`:

```typescript
import { declareActivitiesHandler, qualifyFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

import { orderContract } from "./contract.js";

// Stand-ins for real services.
const paymentGateway = {
  charge: async (customerId: string, amount: number) => {
    if (amount > 1000) {
      throw new Error("amount exceeds the per-transaction limit");
    }
    return { id: `txn_${customerId}_${Math.round(amount * 100)}` };
  },
};

const mailer = {
  send: async (customerId: string, transactionId: string) => {
    console.log(`[mailer] receipt ${transactionId} → ${customerId}`);
  },
};

export const activities = declareActivitiesHandler({
  contract: orderContract,
  activities: {
    // Workflow-scoped activities nest under their workflow's name,
    // mirroring the contract.
    processOrder: {
      chargeCard: ({ customerId, amount }) =>
        fromPromise(
          paymentGateway.charge(customerId, amount),
          qualifyFailure("CHARGE_FAILED", { expected: Error }),
        ).map((charge) => ({ transactionId: charge.id })),

      sendReceipt: ({ customerId, transactionId }) =>
        fromPromise(
          mailer.send(customerId, transactionId),
          qualifyFailure("RECEIPT_FAILED", { expected: Error }),
        ),
    },
  },
});
```

`fromPromise(promise, qualifyFailure(...))` is the shape you will write most often. It
takes a promise that might reject and turns it into an `AsyncResult`:

- if the promise resolves, you get the value on the `ok` channel;
- if it rejects with a cause matching `expected`, `qualifyFailure("CHARGE_FAILED", ...)`
  wraps the rejection in a Temporal `ApplicationFailure` whose `type` is
  `"CHARGE_FAILED"`;
- if it rejects with anything else, the rejection stays a **defect** — an
  unanticipated bug that surfaces loudly instead of masquerading as a charge
  failure.

`expected` is required: it is your triage decision about which failures are
part of the activity's model. The stand-in gateway throws a plain `Error`, so
`expected: Error` is honest here; against a real SDK you would name its error
class instead (see
[Implement activities](/how-to/implement-activities)).

The failure `type` is what Temporal's retry policies key on, which is why it is
worth naming deliberately.

::: tip Why nested?
`chargeCard` and `sendReceipt` are declared inside `processOrder` in the
contract, so their implementations nest under `processOrder` here. Activities
declared at the _contract_ level (available to every workflow) sit at the root
of this map instead. The nesting mirrors the contract so a misplaced
implementation is a type error.
:::

## Step 4 — Implement the workflow

The workflow orchestrates. It must be deterministic — no `Date.now()`, no
`Math.random()`, no direct I/O — because Temporal replays it to recover state.

Create `src/workflows.ts`:

```typescript
import { declareWorkflow, propagateActivityFailure } from "@temporal-contract/worker/workflow";

import { orderContract } from "./contract.js";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderContract,
  activityOptions: {
    startToCloseTimeout: "1 minute",
    // Cap retries so a persistently failing activity fails the workflow
    // instead of retrying forever (Temporal's default policy is unlimited
    // attempts). Step 7 relies on this.
    retry: { maximumAttempts: 3 },
  },
  implementation: async (context, order) => {
    const { transactionId } = await propagateActivityFailure(
      context.activities.chargeCard({
        customerId: order.customerId,
        amount: order.amount,
      }),
    );

    await propagateActivityFailure(
      context.activities.sendReceipt({ customerId: order.customerId, transactionId }),
    );

    return { orderId: order.orderId, transactionId };
  },
});
```

`order` is typed as `{ orderId: string; customerId: string; amount: number }`
without you writing that type. So is the return value — change the returned
object and TypeScript will tell you it no longer satisfies the contract.

Notice that `context.activities.chargeCard(...)` returns an **`AsyncResult`**,
not a plain value — every activity call does, whether or not the contract
declares any `errors`. `propagateActivityFailure` unwraps the success value
and re-raises the original failure on the way out, so Temporal's retry policy
still handles it — the same "let it throw" behavior as before, made explicit
at the call site. See [The result model](/explanation/the-result-model).

(When the workflow itself should branch on a failure instead of letting
Temporal decide, narrow the `AsyncResult` with `isErr()` instead of
propagating it. See [Model domain errors](/how-to/model-domain-errors).)

## Step 5 — Run a worker

A worker is the process that executes your workflow and activity code. It polls
the task queue named in the contract.

Create `src/worker.ts`:

```typescript
import { TypedWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { NativeConnection } from "@temporalio/worker";

import { activities } from "./activities.js";
import { orderContract } from "./contract.js";

const connection = await NativeConnection.connect({ address: "localhost:7233" });

const worker = await TypedWorker.create({
  contract: orderContract,
  connection,
  // Workflows are bundled separately, so they are referenced by path.
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities,
}).get();

console.log("worker listening on task queue 'orders'");
await worker.run().get();
```

Start it:

```bash
npx tsx src/worker.ts
```

You should see `worker listening on task queue 'orders'`. Leave it running.

::: tip Why `workflowsPath` and not an import?
Temporal bundles workflow code into an isolated, deterministic sandbox. It
needs a _path_ to bundle, not a live module object. `workflowsPathFromURL`
resolves one relative to the current file — the ESM-safe equivalent of
`require.resolve`. See [Architecture](/explanation/architecture).
:::

## Step 6 — Start the workflow from a client

Open a second terminal. Create `src/client.ts`:

```typescript
import {
  tagPatterns,
  TypedClient,
  WORKFLOW_RESULT_ERROR_TAGS,
  WORKFLOW_START_ERROR_TAGS,
} from "@temporal-contract/client";
import { Client, Connection } from "@temporalio/client";

import { orderContract } from "./contract.js";

const connection = await Connection.connect({ address: "localhost:7233" });

const client = await TypedClient.create({
  client: new Client({ connection }),
}).get();

// Bind the contract — synchronous, infallible, free to call anywhere.
const orders = client.for(orderContract);

const result = await orders.executeWorkflow("processOrder", {
  workflowId: `order-${Date.now()}`,
  args: {
    orderId: "ORD-1",
    customerId: "CUST-1",
    amount: 42.5,
  },
});

result.match({
  ok: (output) => {
    console.log("charged:", output.transactionId);
  },
  errCases: (matcher) =>
    matcher.with(
      // Tag bundles cover the start-phase and result-phase error unions in
      // one arm — no hand-written list of tags to keep in sync.
      ...tagPatterns(WORKFLOW_START_ERROR_TAGS),
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
charged: txn_CUST-1_4250
```

The worker terminal logs the mailer line. Open <http://localhost:8233> and you
will see the execution, its history, and both activity invocations.

## Step 7 — Watch validation do its job

The client validated your arguments before anything left the process. Prove it
by breaking the contract — change `amount` to a negative number:

```typescript
args: {
  orderId: "ORD-1",
  customerId: "CUST-1",
  amount: -1, // violates z.number().positive()
},
```

Run the client again:

```
workflow failed: Validation failed for workflow "processOrder" input
```

No workflow was started, no worker was involved, and no partial state exists.
The contract rejected the call at the boundary.

Now try a failure on the far side. Restore `amount` to a valid number but make
it large enough that the payment gateway rejects it:

```typescript
amount: 5000, // paymentGateway.charge throws above 1000
```

This time the workflow _does_ start. The activity fails, Temporal retries it
under the `maximumAttempts: 3` policy you set in Step 4, and once the third
attempt fails the client sees a `WorkflowFailedError`. Watch the retries happen
live in the Web UI — that durability is what Temporal is for, and the contract
has not gotten in its way. (Without the cap, Temporal's default policy would
retry the activity indefinitely and the workflow would simply stay `Running`.)

## What you built

```
contract.ts  ──┬──▶ activities.ts  ─┐
               │                     ├─▶ worker.ts   (executes)
               ├──▶ workflows.ts  ───┘
               │
               └──▶ client.ts                        (starts)
```

One contract; four files that derive their types from it; validation at every
boundary the data crosses.

## Next

- [Adding signals and queries](/tutorial/adding-signals-and-queries) picks up
  this exact project and makes the workflow interactive while it runs.
- [The result model](/explanation/the-result-model) explains why every
  activity call returns an `AsyncResult`, and when to narrow it instead of
  propagating it.
- [Model domain errors](/how-to/model-domain-errors) replaces the generic
  `WorkflowFailedError` above with typed, schema-validated failures.
