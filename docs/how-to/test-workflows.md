# Test workflows

There are three tiers, in increasing order of fidelity and cost. Use the
cheapest one that can catch the bug you care about.

| Tier                   | Needs                    | Speed           | Catches                                  |
| ---------------------- | ------------------------ | --------------- | ---------------------------------------- |
| **Contract & handler** | nothing                  | milliseconds    | Schema mistakes, activity logic          |
| **Time-skipping**      | a downloaded test binary | seconds         | Workflow orchestration, timers, signals  |
| **Real server**        | Docker                   | tens of seconds | Visibility, search attributes, schedules |

## Tier 1 — contract and activity handlers

An activity implementation is an ordinary function returning `AsyncResult`, but
do **not** assert on the map that `declareActivitiesHandler` returns — those are
the _wrapped_ handlers a worker registers, and they **throw** `ApplicationFailure`
across the boundary rather than returning a `Result`. `@temporal-contract/testing/activity`
gives you two entry points instead, and neither needs a worker, a server, or
Docker:

- **`runActivity`** runs the **raw** implementation and hands back its
  `AsyncResult` untouched — no input parse, no output validation, no
  contract-error wire conversion. This is the pure-logic tier.
- **`runActivityHandler`** routes the same implementation through the **real**
  `declareActivitiesHandler` wrapping — input parse → implementation → output
  validation → contract-error → `ApplicationFailure` wire conversion →
  rehydration back to a typed `Result`. Use it when a test must be
  boundary-faithful: passing here means the same call succeeds through a real
  worker.

Install the unthrown matchers and register them:

```bash
pnpm add -D vitest @unthrown/vitest
```

```typescript
// vitest.setup.ts
import "@unthrown/vitest";
```

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { setupFiles: ["./vitest.setup.ts"] },
});
```

Then run the implementation with `runActivity` and assert on the result
channels. The subject is the activity's contract definition; the implementation
and input travel in the options bag:

```typescript
import { runActivity } from "@temporal-contract/testing/activity";
import { describe, expect, it } from "vitest";

import { chargeCard } from "./activities.js";
import { orderContract } from "./contract.js";

describe("chargeCard", () => {
  it("returns a transaction id", async () => {
    const result = await runActivity(orderContract.workflows.processOrder.activities.chargeCard, {
      implementation: chargeCard, // ({ errors, input: args }) => AsyncResult<...>
      input: { customerId: "CUST-1", amount: 42 },
    });

    expect(result).toBeOk();
    expect(result).toBeOkWith({ transactionId: expect.any(String) });
  });

  it("surfaces a declined card as a contract error", async () => {
    const result = await runActivity(orderContract.workflows.processOrder.activities.chargeCard, {
      implementation: chargeCard,
      input: { customerId: "DECLINE", amount: 42 },
    });

    expect(result).toBeErrTagged("@temporal-contract/ContractError");
  });
});
```

`@unthrown/vitest` provides `toBeOk`, `toBeOkWith`, `toBeErr`, `toBeErrTagged`,
and `toBeDefect` — prefer them over `expect(result.isOk()).toBe(true)`.

### Test the full boundary with `runActivityHandler`

`runActivity` runs the raw implementation, so an `Err` whose data violates the
declared schema, or an output the schema rejects, still looks green. When the
test must fail exactly where production fails, use `runActivityHandler`: it wraps
the implementation with the real `declareActivitiesHandler`, parses the input as
a caller would send it (the pre-transform wire shape), validates the output, and
round-trips a typed `Err` through its `ApplicationFailure` wire form and back:

```typescript
import { runActivityHandler } from "@temporal-contract/testing/activity";
import { expect, it } from "vitest";

import { chargeCard } from "./activities.js";
import { orderContract } from "./contract.js";

it("rehydrates a declared error across the wire", async () => {
  const result = await runActivityHandler(
    orderContract.workflows.processOrder.activities.chargeCard,
    {
      implementation: chargeCard,
      input: { customerId: "DECLINE", amount: 42 },
    },
  );

  // The declared error crossed the wire and rehydrated as a typed error;
  // an undeclared error name or invalid error data would surface the
  // production terminal `ContractErrorDataValidationError` instead.
  expect(result).toBeErrTagged("@temporal-contract/ContractError");
});
```

Contracts are worth testing too — `defineContract` throws on a malformed one, so
a test that merely imports it is a real check:

```typescript
it("rejects an invalid amount", async () => {
  const parsed = await orderContract.workflows.processOrder.input["~standard"].validate({
    orderId: "ORD-1",
    customerId: "CUST-1",
    amount: -1,
  });

  expect(parsed.issues).toBeDefined();
});
```

### Substitute dependencies

`createContext` is the seam. Build the handler with fakes:

```typescript
import { declareActivitiesHandler, qualifyFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

export const makeActivities = (deps: { gateway: PaymentGateway }) =>
  declareActivitiesHandler({
    contract: orderContract,
    createContext: () => deps,
    activities: {
      processOrder: {
        chargeCard: ({ context, input: { customerId, amount } }) =>
          fromPromise(
            context.gateway.charge(customerId, amount),
            qualifyFailure("CHARGE_FAILED", { expected: GatewayError }),
          ).map((c) => ({ transactionId: c.id })),
      },
    },
  });
```

```typescript
const activities = makeActivities({
  gateway: { charge: async () => ({ id: "txn_test" }) },
});
```

### Observe heartbeats and cancellation

`runActivity` executes the implementation inside `@temporalio/testing`'s
`MockActivityEnvironment`, so `Context.current()` works — heartbeats,
cancellation, and activity info are all live. Both entry points are vitest-free
(they only need `@temporalio/testing`), so they work from any test runner.

Pass your own environment via the `env` option to observe heartbeats or
trigger cancellation:

```typescript
import { runActivity } from "@temporal-contract/testing/activity";
import { MockActivityEnvironment } from "@temporalio/testing";
import { expect, it } from "vitest";

import { downloadReport } from "./activities.js";
import { orderContract } from "./contract.js";

it("heartbeats while downloading", async () => {
  const env = new MockActivityEnvironment();
  const heartbeats: unknown[] = [];
  env.on("heartbeat", (details) => heartbeats.push(details));

  const result = await runActivity(orderContract.workflows.processOrder.activities.downloadReport, {
    implementation: downloadReport,
    input: { reportId: "R-1" },
    env,
  });

  expect(result).toBeOk();
  expect(heartbeats.length).toBeGreaterThan(0);
});
```

`env.cancel()` triggers cancellation the same way; a `CancelledFailure` the
implementation does not model surfaces on the defect channel.

## Tier 2 — time-skipping, no Docker

`@temporal-contract/testing/time-skipping` runs a lightweight local test server
that fast-forwards timers. A workflow that sleeps 30 days finishes instantly.

```bash
pnpm add -D @temporal-contract/testing @temporalio/testing
```

```typescript
import { TypedClient } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import { TypedWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { expect } from "vitest";

import { activities } from "./activities.js";
import { orderContract } from "./contract.js";

it("processes an order", async ({ testEnv }) => {
  const worker = await TypedWorker.create({
    contract: orderContract,
    connection: testEnv.nativeConnection,
    workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
    activities,
  }).get();

  const client = await TypedClient.create({
    client: testEnv.client,
  }).get();

  await worker.raw.runUntil(async () => {
    const result = await client.for(orderContract).executeWorkflow("processOrder", {
      workflowId: "order-test-1",
      args: { orderId: "ORD-1", customerId: "CUST-1", amount: 42 },
    });

    expect(result).toBeOk();
  });
});
```

`worker.raw.runUntil` (on the underlying Temporal worker) starts the worker,
runs the callback, and shuts down cleanly.

The environment is created once per Vitest worker process and torn down when it
exits — spawning one per test would dominate the suite's runtime.

Give the first run a generous timeout; `@temporalio/testing` downloads and
caches the test-server binary:

```typescript
export default defineConfig({
  test: {
    include: ["src/**/*.inprocess.spec.ts"],
    testTimeout: 120_000,
    setupFiles: ["./vitest.setup.ts"],
  },
});
```

The ready-made `it` uses default environment options. To pin the test-server
version or otherwise configure the environment, build your own `it` with
`createTimeSkippingTest` — options are forwarded to
`TestWorkflowEnvironment.createTimeSkipping` unchanged:

```typescript
import { createTimeSkippingTest } from "@temporal-contract/testing/time-skipping";

const it = createTimeSkippingTest({
  server: { executable: { type: "cached-download", version: "v1.3.0" } },
});

it("runs against the pinned server", async ({ testEnv }) => {
  // ...
});
```

If you prefer explicit lifecycle management over the fixture,
`createTimeSkippingEnvironment` accepts the same options (remember to call
`teardown()`):

```typescript
import { createTimeSkippingEnvironment } from "@temporal-contract/testing/time-skipping";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll } from "vitest";

let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
  testEnv = await createTimeSkippingEnvironment();
});

afterAll(async () => {
  await testEnv.teardown();
});
```

### Test time-dependent behaviour

```typescript
it("expires an unapproved order after 24 hours", async ({ testEnv }) => {
  // ... worker + client setup ...

  await worker.raw.runUntil(async () => {
    const started = await client.for(orderContract).startWorkflow("processOrder", {
      workflowId: "order-expiry",
      args: { orderId: "ORD-1", customerId: "CUST-1", amount: 42 },
    });

    // The workflow's `condition(..., "24 hours")` elapses immediately.
    const result = await started.getOrThrow().result();

    expect(result).toBeOkWith({ status: "expired" });
  });
});
```

## Tier 3 — a real server in Docker

For visibility queries, search attributes, schedules, and retention, you need a
real cluster. `@temporal-contract/testing/global-setup` starts Temporal and
PostgreSQL in testcontainers for the suite's lifetime.

`testcontainers` is an **optional** peer dependency, pulled in only by this
Dockerized tier (`createGlobalSetup` / `createContractTest`) — the
`/time-skipping` and `/activity` entries do not need it. Install it alongside
`@temporal-contract/testing` for tier 3:

```bash
pnpm add -D @temporal-contract/testing testcontainers
```

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "@temporal-contract/testing/global-setup",
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30_000,
  },
});
```

To pin container images, inject extra Temporal env, or silence the container
progress logs, point `globalSetup` at your own module that default-exports
`createGlobalSetup(options)`:

```typescript
// temporal-global-setup.ts
import { createGlobalSetup } from "@temporal-contract/testing/global-setup";

export default createGlobalSetup({
  postgresImage: "postgres:18.1",
  temporalImage: "temporalio/auto-setup:1.28.0",
  temporalEnv: { FRONTEND_GRPC_MAX_MESSAGE_SIZE: "10485760" },
  quiet: true,
});
```

### Wire the whole stack with `createContractTest`

`@temporal-contract/testing/contract` builds a vitest `it` whose fixtures run
a contract against that server: a worker on the contract's task queue
(started before each test, shut down after), the connection-scoped
`TypedClient` root, and the contract-bound `ContractClient`. Destructure
exactly what you use — `client`, `typedClient`, or `worker`:

```typescript
import { createContractTest } from "@temporal-contract/testing/contract";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { describe, expect } from "vitest";

import { activities } from "./activities.js";
import { orderContract } from "./contract.js";

const it = createContractTest({
  contract: orderContract,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities, // omit for a workflow-only worker
  // workerOptions: forwarded to TypedWorker.create (namespace, interceptors, tuning)
});

describe("order processing", () => {
  it("processes an order end-to-end", async ({ client }) => {
    const result = await client.executeWorkflow("processOrder", {
      workflowId: `order-${Date.now()}`,
      args: { orderId: "ORD-1", customerId: "CUST-1", amount: 42 },
    });

    expect(result).toBeOk();
  });
});
```

### Or wire it yourself with the connection fixtures

`@temporal-contract/testing/extension` supplies connections bound to that
container:

```typescript
import { TypedClient } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/extension";
import { TypedWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { Client } from "@temporalio/client";
import { expect } from "vitest";

it("indexes the order by customer", async ({ clientConnection, workerConnection }) => {
  const worker = await TypedWorker.create({
    contract: orderContract,
    connection: workerConnection,
    workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
    activities,
  }).get();

  const client = await TypedClient.create({
    client: new Client({ connection: clientConnection }),
  }).get();

  await worker.raw.runUntil(async () => {
    const result = await client.for(orderContract).executeWorkflow("processOrder", {
      workflowId: "order-search-1",
      args: { orderId: "ORD-1", customerId: "CUST-1", amount: 42 },
      searchAttributes: { customerId: "CUST-1" },
    });

    expect(result).toBeOk();
  });
});
```

The fixtures are `clientConnection` (a `Connection`, for the client) and
`workerConnection` (a `NativeConnection`, for the worker). Docker must be
running.

## Split the tiers into projects

Keep fast tests fast by separating them:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.spec.ts"],
          exclude: ["src/**/__tests__/*.spec.ts"],
          setupFiles: ["./src/vitest.setup.ts"],
        },
      },
      {
        test: {
          name: "inprocess",
          include: ["src/**/__tests__/*.inprocess.spec.ts"],
          testTimeout: 120_000,
          setupFiles: ["./src/vitest.setup.ts"],
        },
      },
      {
        test: {
          name: "integration",
          globalSetup: "@temporal-contract/testing/global-setup",
          include: ["src/**/__tests__/*.spec.ts"],
          exclude: ["src/**/__tests__/*.inprocess.spec.ts"],
          testTimeout: 30_000,
          setupFiles: ["./src/vitest.setup.ts"],
        },
      },
    ],
  },
});
```

```bash
vitest run --project unit          # every commit
vitest run --project inprocess     # every commit, still no Docker
vitest run --project integration   # CI, or before a release
```

## Which tier for which bug

- **Wrong schema, bad activity logic, error mapping** → tier 1. Do not reach
  for a server.
- **Wrong orchestration: step order, signal handling, timers, compensation** →
  tier 2.
- **Search attributes, schedules, visibility queries, retention** → tier 3.

Most suites are mostly tier 1, with a handful of tier 2 tests covering each
workflow's happy path and its main failure branch.

## Next

- [Implement activities](/how-to/implement-activities) — the `createContext`
  seam
- [Configure a worker](/how-to/configure-a-worker)
- [Troubleshoot](/how-to/troubleshoot)
