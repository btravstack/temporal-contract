# Configure a worker

A worker is the process that executes your workflow and activity code. It polls
the task queue named on the contract.

## Minimal worker

```typescript
import { TypedWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { NativeConnection } from "@temporalio/worker";

import { activities } from "./activities.js";
import { orderContract } from "./contract.js";

const connection = await NativeConnection.connect({ address: "localhost:7233" });

const worker = await TypedWorker.create({
  contract: orderContract,
  connection,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities,
}).getOrThrow();

await worker.run().getOrThrow();
```

`taskQueue` comes from the contract, so you never repeat it. Everything else on
Temporal's `WorkerOptions` is accepted and passed through.
`TypedWorker.create` replaces the old free `createWorker` function.

## Handle a failed start

`TypedWorker.create` returns `AsyncResult<TypedWorker, never>` — there is no modeled error.
Bundling failures, bad connections, and invalid options are _technical_ faults,
so they ride the **defect** channel with a `TechnicalError` cause:

```typescript
const result = await TypedWorker.create({
  contract: orderContract,
  connection,
  workflowsPath,
  activities,
});

if (result.isDefect()) {
  console.error("worker setup failed:", result.cause);
  process.exit(1);
}

// Past the guard the only remaining variant is `Ok` — the error channel is
// `never` — so unwrap and run.
await result.getOrThrow().run().getOrThrow();
```

`.getOrThrow()` is the terse form — on a defect it rethrows the original cause
with its stack intact, which is usually what you want at process startup. (With
a `never` error channel `.get()` would compile too, but `.getOrThrow()` is the
one idiom that stays correct if a modeled error is ever added.)

`run()` has the same shape: it returns `AsyncResult<void, never>`, so a worker
that fails while running surfaces as a defect (a `TechnicalError` cause) rather
than a rejected promise — `await worker.run().getOrThrow()` rethrows it at the
edge. The underlying Temporal `Worker` stays available as `worker.raw` for
anything the typed surface doesn't cover (`worker.raw.getState()`,
`worker.raw.runUntil(...)`).

## Verify workflow registration

`TypedWorker.create` verifies workflow registration by default: it imports the
`workflowsPath` module and checks that every contract workflow is exported
under its declared name. Creation fails (a `TechnicalError`-caused defect) when

- a contract workflow is missing from the bundle — a forgotten
  `declareWorkflow` export that would otherwise surface only when the first
  task for it was dispatched; or
- a workflow is exported under a name that differs from its `workflowName` —
  Temporal registers workflows by export name, so the mismatch would register
  it as the wrong workflow type.

Opt out with `verifyWorkflowRegistration: false`, for example when the
workflows module intentionally exports helpers whose names shadow contract
workflows:

```typescript
const worker = await TypedWorker.create({
  contract: orderContract,
  connection,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities,
  verifyWorkflowRegistration: false,
}).getOrThrow();
```

The check is best-effort: it only runs when `workflowsPath` is provided
(prebuilt `workflowBundle`s are skipped), and a module that cannot be imported
in the main thread is skipped silently — `Worker.create`'s bundler is the
authority on whether the module loads at all.

## Resolve the workflows path

Temporal bundles workflow code into an isolated sandbox, so it needs a _path_,
not a module object. `workflowsPathFromURL` resolves one relative to the current
file — the ESM-safe equivalent of `require.resolve`:

```typescript
workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js");
```

Always include the extension, and always write `.js` even though the source is
`.ts` — the same rule as every other ESM import. This keeps the path correct in
both source and built layouts.

## Structure the entry points

Workflow code is bundled and sandboxed; activity code is not. Keeping them in
separate files is not stylistic — a workflow file that transitively imports a
database driver will fail to bundle.

```
src/
  contract.ts     ← schemas only. Imported by everything.
  activities.ts   ← I/O, SDK clients, database access
  workflows.ts    ← orchestration only. Bundled by Temporal.
  worker.ts       ← wires the two together
  client.ts       ← separate process
```

The rule: **`workflows.ts` may import `contract.ts` and nothing with side
effects.** See [Architecture](/explanation/architecture).

## Run a workflow-only worker

`activities` is optional. Omit it and the worker registers no activities and
polls exclusively for Workflow Tasks:

```typescript
import { TypedWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { NativeConnection } from "@temporalio/worker";

import { orderContract } from "./contract.js";

const connection = await NativeConnection.connect({ address: "localhost:7233" });

const worker = await TypedWorker.create({
  contract: orderContract,
  connection,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  // no `activities`
}).getOrThrow();

await worker.run().getOrThrow();
```

This is the split-deployment pattern: workflows are deterministic and
CPU-light, activities do the heavy I/O, and the two often deserve different
scaling profiles. Run one workflow-only worker process and a separate
activity worker process (a `TypedWorker.create` call _with_ `activities`) on the
same task queue — Temporal routes each task kind to whichever worker polls
for it.

```typescript
const worker = await TypedWorker.create({
  contract: orderContract,
  connection,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities,

  maxConcurrentActivityTaskExecutions: 100,
  maxConcurrentWorkflowTaskExecutions: 40,
  maxConcurrentLocalActivityExecutions: 100,

  // Cap the rate at which this worker pulls new work.
  maxTaskQueueActivitiesPerSecond: 50,
}).getOrThrow();
```

Activity concurrency is the usual bottleneck. Raise it for I/O-bound work; keep
it low for CPU-bound or memory-hungry activities.

## Shut down gracefully

```typescript
const worker = await TypedWorker.create({/* ... */}).getOrThrow();

process.on("SIGTERM", () => {
  console.log("draining...");
  worker.shutdown();
});

await worker.run().getOrThrow(); // resolves once in-flight tasks finish
await connection.close();
```

`shutdown()` stops polling for new tasks and lets in-flight ones finish. In
Kubernetes, set `terminationGracePeriodSeconds` above your longest
`startToCloseTimeout` so activities are not killed mid-flight.

Run the worker for a bounded scope instead when you want automatic cleanup —
`runUntil` lives on the raw Temporal worker:

```typescript
await worker.raw.runUntil(async () => {
  // worker is running for this block only
});
```

This is the idiom for tests — see [Test workflows](/how-to/test-workflows).

## Run several workers in one process

Each contract needs its own worker, because each has its own task queue:

```typescript
const [orderWorker, shipmentWorker] = await Promise.all([
  TypedWorker.create({
    contract: orderContract,
    connection,
    workflowsPath: workflowsPathFromURL(import.meta.url, "./order.workflows.js"),
    activities: orderActivities,
  }).getOrThrow(),
  TypedWorker.create({
    contract: shipmentContract,
    connection,
    workflowsPath: workflowsPathFromURL(import.meta.url, "./shipment.workflows.js"),
    activities: shipmentActivities,
  }).getOrThrow(),
]);

await Promise.all([orderWorker.run().getOrThrow(), shipmentWorker.run().getOrThrow()]);
```

They share the connection. Split them into separate processes when their
resource profiles differ — that is the point of a dedicated task queue.

## Connect to Temporal Cloud

```typescript
import { readFileSync } from "node:fs";

const connection = await NativeConnection.connect({
  address: "my-namespace.a1b2c.tmprl.cloud:7233",
  tls: {
    clientCertPair: {
      crt: readFileSync("/secrets/client.pem"),
      key: readFileSync("/secrets/client.key"),
    },
  },
});

const worker = await TypedWorker.create({
  contract: orderContract,
  connection,
  namespace: "my-namespace.a1b2c",
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities,
}).getOrThrow();
```

## Add logging

```typescript
import { Runtime, DefaultLogger } from "@temporalio/worker";

Runtime.install({
  logger: new DefaultLogger("INFO", ({ level, message, meta }) => {
    logger[level.toLowerCase()]({ ...meta }, message);
  }),
});
```

Inside workflow code, use `log` from `@temporalio/workflow` — it is replay-safe
and routed through this sink. A bare `console.log` in a workflow re-fires on
every replay.

## Next

- [Test workflows](/how-to/test-workflows)
- [Architecture](/explanation/architecture) — why the entry points are split
- [Worker surface](/reference/worker-surface)
