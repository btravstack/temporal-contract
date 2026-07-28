# Use signals, queries, and updates

These are the three ways to interact with a workflow while it is running.

|            | Sends data | Returns data | Blocks the caller             | Handler must be |
| ---------- | ---------- | ------------ | ----------------------------- | --------------- |
| **Query**  | yes        | yes          | until answered (immediate)    | synchronous     |
| **Signal** | yes        | no           | no                            | sync or async   |
| **Update** | yes        | yes          | until the workflow handles it | async           |

Queries read state and must not modify it. Signals notify. Updates change state
and confirm.

## Declare them on the contract

```typescript
import {
  defineQuery,
  defineSignal,
  defineUpdate,
  defineWorkflow,
} from "@temporal-contract/contract";
import { z } from "zod";

const getProgress = defineQuery({
  input: z.object({}), // no arguments
  output: z.object({ completed: z.number(), total: z.number() }),
});

const cancelRequested = defineSignal({
  input: z.object({ reason: z.string() }),
});

const addItems = defineUpdate({
  input: z.object({ skus: z.array(z.string()).min(1) }),
  output: z.object({ total: z.number() }),
});

export const importCatalog = defineWorkflow({
  input: z.object({ catalogId: z.string() }),
  output: z.object({ imported: z.number() }),
  queries: { getProgress },
  signals: { cancelRequested },
  updates: { addItems },
});
```

::: warning Query schemas must validate synchronously
Temporal requires query handlers to complete synchronously, so a query's input
and output schemas must too. Plain object schemas are fine; async refinements
(`z.string().refine(async ...)`) are not. Standard Schema does not expose the
sync/async distinction at the type level, so this is enforced at runtime — the
worker throws if a schema returns a `Promise`.
:::

## Handle them in the workflow

Register handlers **inside** the implementation so they can close over workflow
state:

```typescript
import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { condition } from "@temporalio/workflow";

export const importCatalog = declareWorkflow({
  workflowName: "importCatalog",
  contract: catalogContract,
  activityOptions: { startToCloseTimeout: "5 minutes" },
  implementation: async (context, args) => {
    let completed = 0;
    let pending = await context.activities.listSkus({ catalogId: args.catalogId });
    let cancelReason: string | undefined;

    // Query: synchronous, reads only.
    context.defineQuery("getProgress", () => ({
      completed,
      total: completed + pending.length,
    }));

    // Signal: fire-and-forget.
    context.defineSignal("cancelRequested", (signalArgs) => {
      cancelReason = signalArgs.reason;
    });

    // Update: async, returns a value to the caller.
    context.defineUpdate("addItems", async (updateArgs) => {
      pending = [...pending, ...updateArgs.skus];
      return { total: completed + pending.length };
    });

    while (pending.length > 0 && cancelReason === undefined) {
      const [next, ...rest] = pending;
      pending = rest;
      await context.activities.importSku({ sku: next });
      completed += 1;
    }

    return { imported: completed };
  },
});
```

Handler names are checked against the contract — a typo is a compile error, and
argument and return types come from the schemas.

## Wait for a signal

Never poll and never `setTimeout`. Use Temporal's `condition`, which is
replay-safe:

```typescript
import { condition } from "@temporalio/workflow";

// Block until approved.
await condition(() => approved);

// Or with a timeout — resolves false if it elapses first.
const approvedInTime = await condition(() => approved, "24 hours");
if (!approvedInTime) {
  return { status: "expired" };
}
```

## Call them from the client

Get a handle, then use the generated `queries`, `signals`, and `updates` maps:

```typescript
const started = await client.startWorkflow("importCatalog", {
  workflowId: "import-2024",
  args: { catalogId: "cat-1" },
});

if (started.isErr()) {
  throw started.error;
}
const handle = started.value;

// Query
const progress = await handle.queries.getProgress({});
if (progress.isOk()) {
  console.log(`${progress.value.completed}/${progress.value.total}`);
}

// Update — waits for the workflow to process it
const updated = await handle.updates.addItems({ skus: ["SKU-9", "SKU-10"] });
console.log(updated.getOrThrow().total);

// Signal — returns as soon as it is delivered.
// Unwrap it: `await` alone yields a Result and would silently drop a failed
// delivery (AsyncResult is a success-only thenable and never rejects).
(await handle.signals.cancelRequested({ reason: "operator stopped the import" })).getOrThrow();

// Final result
const result = await handle.result();
```

Every call returns an `AsyncResult`. Their error channels are narrow:

| Call          | Error channel                                             |
| ------------- | --------------------------------------------------------- |
| `queries.x()` | `QueryValidationError \| WorkflowExecutionNotFoundError`  |
| `signals.x()` | `SignalValidationError \| WorkflowExecutionNotFoundError` |
| `updates.x()` | `UpdateValidationError \| WorkflowExecutionNotFoundError` |

::: warning `await` does not throw on failure
`AsyncResult` is a success-only thenable — awaiting it collapses it to a
`Result`, and the underlying promise never rejects. A bare
`await handle.signals.x(...)` therefore discards the failure and the workflow
simply never receives the signal. Unwrap with `.getOrThrow()`, or branch on
`isErr()` / `isDefect()`.
:::

## Reach an existing workflow

You do not need to have started it. `getHandle` binds to a running execution by
id. It returns an `AsyncResult` — the error channel covers a workflow name that
is not on the contract:

```typescript
const bound = await client.getHandle("importCatalog", "import-2024");
if (bound.isErr()) {
  throw bound.error;
}
const handle = bound.value;

const progress = await handle.queries.getProgress({});
console.log(progress.getOrThrow());

(await handle.signals.cancelRequested({ reason: "budget exhausted" })).getOrThrow();
```

## Signal-with-start

To signal a workflow that may not exist yet, `signalWithStart` starts it if
needed and delivers the signal either way — one round trip, no race:

```typescript
const result = await client.signalWithStart("importCatalog", {
  workflowId: "import-2024",
  args: { catalogId: "cat-1" },
  signalName: "cancelRequested",
  signalArgs: { reason: "superseded" },
});

if (result.isOk()) {
  // `signaledRunId` identifies the execution that received the signal —
  // not necessarily a newly started one.
  console.log(result.value.signaledRunId);
}
```

This is the standard way to build "create or update" semantics on top of a
workflow.

## Drain handlers before returning

A workflow that returns while a signal or update handler is still in flight
will drop that work. Wait for handlers to finish:

```typescript
import { allHandlersFinished, condition } from "@temporalio/workflow";

// ... main workflow body ...

await condition(() => allHandlersFinished());
return { imported: completed };
```

This matters most for async update handlers, which may be mid-await when the
main body completes.

## Keep queries cheap and pure

A query handler runs inside the workflow sandbox and must return immediately.
It must not call activities, sleep, mutate state, or await anything:

```typescript
// ✅
context.defineQuery("getProgress", () => ({ completed, total }));

// ❌ modifies state — corrupts replay
context.defineQuery("getProgress", () => {
  queryCount += 1;
  return { completed, total };
});

// ❌ not synchronous — will not type-check
context.defineQuery("getProgress", async () => ({ completed, total }));
```

## Next

- [Adding signals and queries](/tutorial/adding-signals-and-queries) — the same
  material as a guided lesson
- [Client surface](/reference/client-surface) — the full handle API
- [Workflow determinism](/explanation/workflow-determinism) — why `condition`
  and not `setTimeout`
