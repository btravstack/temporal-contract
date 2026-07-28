# Configure a worker

A worker is the process that executes your workflow and activity code. It polls
the task queue named on the contract.

## Minimal worker

```typescript
import { createWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { NativeConnection } from "@temporalio/worker";

import { activities } from "./activities.js";
import { orderContract } from "./contract.js";

const connection = await NativeConnection.connect({ address: "localhost:7233" });

const worker = await createWorker({
  contract: orderContract,
  connection,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities,
}).get();

await worker.run();
```

`taskQueue` comes from the contract, so you never repeat it. Everything else on
Temporal's `WorkerOptions` is accepted and passed through.

## Handle a failed start

`createWorker` returns `AsyncResult<Worker, never>` — there is no modeled error.
Bundling failures, bad connections, and invalid options are _technical_ faults,
so they ride the **defect** channel with a `TechnicalError` cause:

```typescript
const result = await createWorker({
  contract: orderContract,
  connection,
  workflowsPath,
  activities,
});

if (result.isDefect()) {
  console.error("worker setup failed:", result.cause);
  process.exit(1);
}

await result.value.run();
```

`.get()` is the terse form — on a defect it rethrows the original cause with its
stack intact, which is usually what you want at process startup.

::: tip `createWorkerOrThrow` is deprecated
It exists to ease migration from the pre-`AsyncResult` API and will be removed
in a future major. Use `createWorker`.
:::

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

## Tune concurrency

```typescript
const worker = await createWorker({
  contract: orderContract,
  connection,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities,

  maxConcurrentActivityTaskExecutions: 100,
  maxConcurrentWorkflowTaskExecutions: 40,
  maxConcurrentLocalActivityExecutions: 100,

  // Cap the rate at which this worker pulls new work.
  maxTaskQueueActivitiesPerSecond: 50,
}).get();
```

Activity concurrency is the usual bottleneck. Raise it for I/O-bound work; keep
it low for CPU-bound or memory-hungry activities.

## Shut down gracefully

```typescript
const worker = await createWorker({/* ... */}).get();

process.on("SIGTERM", () => {
  console.log("draining...");
  worker.shutdown();
});

await worker.run(); // resolves once in-flight tasks finish
await connection.close();
```

`shutdown()` stops polling for new tasks and lets in-flight ones finish. In
Kubernetes, set `terminationGracePeriodSeconds` above your longest
`startToCloseTimeout` so activities are not killed mid-flight.

Run the worker for a bounded scope instead when you want automatic cleanup:

```typescript
await worker.runUntil(async () => {
  // worker is running for this block only
});
```

This is the idiom for tests — see [Test workflows](/how-to/test-workflows).

## Run several workers in one process

Each contract needs its own worker, because each has its own task queue:

```typescript
const [orderWorker, shipmentWorker] = await Promise.all([
  createWorker({
    contract: orderContract,
    connection,
    workflowsPath: workflowsPathFromURL(import.meta.url, "./order.workflows.js"),
    activities: orderActivities,
  }).get(),
  createWorker({
    contract: shipmentContract,
    connection,
    workflowsPath: workflowsPathFromURL(import.meta.url, "./shipment.workflows.js"),
    activities: shipmentActivities,
  }).get(),
]);

await Promise.all([orderWorker.run(), shipmentWorker.run()]);
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

const worker = await createWorker({
  contract: orderContract,
  connection,
  namespace: "my-namespace.a1b2c",
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities,
}).get();
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
