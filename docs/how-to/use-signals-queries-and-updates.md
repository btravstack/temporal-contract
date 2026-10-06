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
  defineActivity,
  defineContract,
  defineQuery,
  defineSignal,
  defineUpdate,
  defineWorkflow,
} from "@temporal-contract/contract";
import { z } from "zod";

const listSkus = defineActivity({
  input: z.object({ catalogId: z.string() }),
  output: z.array(z.string()),
});

const importSku = defineActivity({
  input: z.object({ sku: z.string() }),
  output: z.void(),
});

const getProgress = defineQuery({
  // no `input` — an argument-less query
  output: z.object({ completed: z.number(), total: z.number() }),
});

const cancelRequested = defineSignal({
  input: z.object({ reason: z.string() }),
});

const addItems = defineUpdate({
  input: z.object({ skus: z.array(z.string()).min(1) }),
  output: z.object({ total: z.number() }),
});

const importCatalog = defineWorkflow({
  input: z.object({ catalogId: z.string() }),
  output: z.object({ imported: z.number() }),
  startPolicy: "allow-duplicate",
  activities: { listSkus, importSku },
  queries: { getProgress },
  signals: { cancelRequested },
  updates: { addItems },
});

export const catalogContract = defineContract({
  taskQueue: "catalog",
  workflows: { importCatalog },
});
```

`input` is optional on all three. Omit it — `defineSignal()`,
`defineQuery({ output })`, `defineUpdate({ output })` — and the handler
receives `undefined` while the client-side payload argument becomes
omittable. No `z.void()` ceremony.

::: warning Query and update-input schemas must validate synchronously
Temporal runs query handlers and the update **validator** slot synchronously,
so a query's `input` and `output` schemas — and an update's `input` schema —
must validate synchronously too. Plain object schemas are fine; async
refinements (`z.string().refine(async ...)`) are not. An update's `output`
schema may be async, because the update handler itself runs asynchronously.

Standard Schema does not expose the sync/async distinction at the type level,
and a schema may go async only for some inputs (an async `.refine` runs after
the synchronous base check passes), so this is checked **per call**: the first
query or update whose `validate()` returns a `Promise` in one of those slots
fails with a `ContractMisuseError` (a non-retryable `ApplicationFailure`).
:::

## Handle them in the workflow

Register handlers **inside** the implementation so they can close over workflow
state:

```typescript
import { declareWorkflow, propagateFailure } from "@temporal-contract/worker/workflow";
import { condition } from "@temporalio/workflow";

export const importCatalog = declareWorkflow({
  workflowName: "importCatalog",
  contract: catalogContract,
  activityOptions: { startToCloseTimeout: "5 minutes", retry: { maximumAttempts: 3 } },
  implementation: async (context, args) => {
    let completed = 0;
    let pending = await propagateFailure(
      context.activities.listSkus({ catalogId: args.catalogId }),
    );
    let cancelReason: string | undefined;

    // Query: synchronous, reads only.
    context.handleQuery("getProgress", () => ({
      completed,
      total: completed + pending.length,
    }));

    // Signal: fire-and-forget.
    context.handleSignal("cancelRequested", (signalArgs) => {
      cancelReason = signalArgs.reason;
    });

    // Update: async, returns a value to the caller.
    context.handleUpdate("addItems", async (updateArgs) => {
      pending = [...pending, ...updateArgs.skus];
      return { total: completed + pending.length };
    });

    while (pending.length > 0 && cancelReason === undefined) {
      const [next, ...rest] = pending;
      pending = rest;
      await propagateFailure(context.activities.importSku({ sku: next }));
      completed += 1;
    }

    return { imported: completed };
  },
});
```

Handler names are checked against the contract — a typo is a compile error, and
argument and return types come from the schemas.

A signal or update handler that throws one of the library's own workflow-side
errors — `throw result.error` or `.getOrThrow()` on an `ActivityError`,
`ChildWorkflowError`, or a `*CancelledError` — is mapped to the Temporal
failure that error carries, exactly as `propagateFailure` would: a signal
handler's throw fails the workflow, and an update handler's throw fails that
update (`UpdateFailedError` for the caller) instead of retrying the workflow
task forever.

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

Bind the contract, get a handle, then use the generated `queries`, `signals`,
and `updates` maps:

```typescript
const catalog = typedClient.for(catalogContract);

const started = await catalog.startWorkflow("importCatalog", {
  workflowId: "import-2024",
  args: { catalogId: "cat-1" },
});

// `.getOrThrow()` unwraps the `Ok` and rethrows a modeled error or a defect —
// narrowing with `isErr()` alone would leave the defect variant, which has no
// `.value`. The handle follows the run chain, so its `runId` is `undefined`;
// `firstExecutionRunId` is the run just started.
const handle = started.getOrThrow();

// Query — the payload argument is omittable for an input-less definition
const progress = await handle.queries.getProgress();
if (progress.isOk()) {
  console.log(`${progress.value.completed}/${progress.value.total}`);
}

// Update — waits for the workflow to process it. The optional second
// argument carries an `updateId` (dedupe key, and the ID to reattach with).
const updated = await handle.updates.addItems(
  { skus: ["SKU-9", "SKU-10"] },
  { updateId: "add-sku-9-10" },
);
console.log(updated.getOrThrow().total);

// Signal — returns as soon as it is delivered.
// Unwrap it: `await` alone yields a Result and would silently drop a failed
// delivery (AsyncResult is a success-only thenable and never rejects).
(await handle.signals.cancelRequested({ reason: "operator stopped the import" })).getOrThrow();

// Final result
const result = await handle.result();
```

Every call returns an `AsyncResult`. Their error channels are narrow:

| Call          | Error channel                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `queries.x()` | `QueryValidationError \| QueryFailedError \| WorkflowExecutionNotFoundError`                                                              |
| `signals.x()` | `SignalValidationError \| WorkflowExecutionNotFoundError`                                                                                 |
| `updates.x()` | `UpdateValidationError \| UpdateRejectedError \| UpdateFailedError \| UpdateRpcTimeoutOrCancelledError \| WorkflowExecutionNotFoundError` |

`QUERY_PATTERNS`, `SIGNAL_PATTERNS`, and `UPDATE_PATTERNS` cover each union in
one matcher arm. `UpdateRpcTimeoutOrCancelledError` means the update _call_
timed out or was cancelled — the update itself may still be admitted and run,
so retry with the same `updateId` or reattach (below).

::: warning `await` does not throw on failure
`AsyncResult` is a success-only thenable — awaiting it collapses it to a
`Result`, and the underlying promise never rejects. A bare
`await handle.signals.x(...)` therefore discards the failure and the workflow
simply never receives the signal. Unwrap with `.getOrThrow()`, or branch on
`isErr()` / `isDefect()`.
:::

::: info What happens to an invalid signal on the worker
Client-side validation catches a malformed payload before dispatch. If an
invalid signal payload reaches the worker anyway — a stale client, another
SDK — the worker **drops the signal and logs a warning** (`log.warn`, with
the signal name and issues). It never fails the execution: a fire-and-forget
message must not be able to kill a workflow. Queries and updates instead
reject that one call.
:::

## Start an update without waiting

The `updates` map executes and waits. To fire an update and collect its
result later, use `startUpdate` — it returns a typed update handle:

```typescript
const startedUpdate = await handle.startUpdate("addItems", {
  args: { skus: ["SKU-11"] },
  updateId: "add-sku-11", // optional dedupe key
});

if (startedUpdate.isOk()) {
  // ... do other work ...
  const outcome = await startedUpdate.value.result();
  console.log(outcome.getOrThrow().total);
}
```

The handle carries `updateId`, `workflowId`, and `workflowRunId`; `options`
is omittable for an argument-less update (`defineUpdate({ output })`).

`startUpdate` returns once the update is accepted **or rejected**, so its own
error channel is only `UpdateValidationError`,
`UpdateRpcTimeoutOrCancelledError`, or `WorkflowExecutionNotFoundError`. A
worker-side rejection (`UpdateRejectedError`) or a failed handler
(`UpdateFailedError`) surfaces on the update handle's `result()`.

To reattach to an update sent earlier — from another process, or after a
timed-out call — use its `updateId`. `getUpdateHandle` is synchronous; nothing
is sent until `result()`:

```typescript
const reattached = handle.getUpdateHandle("addItems", "add-sku-11");
console.log((await reattached.result()).getOrThrow().total);
```

## Update-with-start

`executeUpdateWithStart` starts the workflow (or, under
`workflowIdConflictPolicy: "USE_EXISTING"`, reuses the running one) and sends
it an update in one request, waiting for the update's result:

```typescript
const added = await catalog.executeUpdateWithStart("importCatalog", {
  workflowId: "import-2024",
  args: { catalogId: "cat-1" },
  workflowIdConflictPolicy: "USE_EXISTING",
  updateName: "addItems",
  updateArgs: { skus: ["SKU-12"] },
});
```

Both `args` and `updateArgs` are validated before anything is sent. To reach
the workflow afterwards, `getHandle` it by ID.

## Reach an existing workflow

You do not need to have started it. `getHandle` binds to a running execution
by id. It is **synchronous and infallible**, like Temporal's — no I/O is
involved, so it returns the handle itself. Whether the execution exists is
answered by the handle's methods, as `WorkflowExecutionNotFoundError`:

```typescript
const handle = catalog.getHandle("importCatalog", "import-2024");

const progress = await handle.queries.getProgress();
console.log(progress.getOrThrow());

(await handle.signals.cancelRequested({ reason: "budget exhausted" })).getOrThrow();
```

Pass options to pin a run or interlock the chain:
`catalog.getHandle("importCatalog", "import-2024", { runId })` binds a
specific execution; `{ firstExecutionRunId }` makes mutating methods refuse
to cross into another execution chain.

For a workflow whose contract derives its ID (`defineWorkflow({ workflowId })`),
compute the ID with `workflowIdFor` rather than rebuilding the format by hand.
It is only callable for such workflows — say an `orders` contract whose
`processOrder` declares `` workflowId: (input) => `order-${input.orderId}` ``:

```typescript
const handle = await orders
  .workflowIdFor("processOrder", { orderId: "ORD-1" })
  .map((workflowId) => orders.getHandle("processOrder", workflowId));
```

## Signal-with-start

To signal a workflow that may not exist yet, `signalWithStart` starts it if
needed and delivers the signal either way — one round trip, no race:

```typescript
const result = await catalog.signalWithStart("importCatalog", {
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

`workflowId` follows the same rule as `startWorkflow`: required, or forbidden
for a workflow whose contract derives it. This is the standard way to build
"create or update" semantics on top of a workflow.

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
context.handleQuery("getProgress", () => ({ completed, total }));

// ❌ modifies state — corrupts replay
context.handleQuery("getProgress", () => {
  queryCount += 1;
  return { completed, total };
});

// ❌ not synchronous — will not type-check
context.handleQuery("getProgress", async () => ({ completed, total }));
```

## Next

- [Adding signals and queries](/tutorial/adding-signals-and-queries) — the same
  material as a guided lesson
- [Client surface](/reference/client-surface) — the full handle API
- [Workflow determinism](/explanation/workflow-determinism) — why `condition`
  and not `setTimeout`
