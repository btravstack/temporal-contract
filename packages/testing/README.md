# @temporal-contract/testing

> Testing utilities for temporal-contract integration tests

[![npm version](https://img.shields.io/npm/v/@temporal-contract/testing.svg?logo=npm)](https://www.npmjs.com/package/@temporal-contract/testing)

## Installation

```bash
# 8.0 beta — `latest` still resolves 7.x
pnpm add -D @temporal-contract/testing@beta

# Required peers (skip what you already have)
pnpm add @temporal-contract/contract@beta @temporal-contract/client@beta \
         @temporal-contract/worker@beta unthrown @temporalio/client @temporalio/worker

# Optional peers, per entry point you use
pnpm add -D vitest                # every entry except /activity and /workflow-bundle
pnpm add -D @temporalio/testing   # /activity, /time-skipping, /test-rig
pnpm add -D testcontainers        # /global-setup (Docker)
```

The `@temporal-contract/*` peers must resolve to _your_ copies — the contract-aware fixtures hand you a `TypedClient` and run a worker. The `@temporalio/*` peers need `^1.24.0`, `unthrown` `^5.11.0`, `vitest` `^4 || ^5`. See [Install temporal-contract](https://btravstack.github.io/temporal-contract/how-to/install) for the full matrix.

## Quick Example

### Global Setup

Configure Vitest to start a Temporal server (via testcontainers — requires Docker) before all tests:

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "@temporal-contract/testing/global-setup",
    testTimeout: 60000,
  },
});
```

To pin container images, inject extra Temporal env, or silence the progress logs, reference your own module that default-exports `createGlobalSetup(options)`:

```typescript
// temporal-global-setup.ts
import { createGlobalSetup } from "@temporal-contract/testing/global-setup";

export default createGlobalSetup({
  temporalImage: "temporalio/auto-setup:1.28.0",
  healthCheckRetries: 120, // one per second; default 60
  quiet: true,
});
```

The default images are pinned by digest; Postgres gets a random password per run and is reachable only from the Temporal container.

### Contract-Aware Fixtures

`createContractTest` wires the whole stack for one contract — a running worker, the connection-scoped `TypedClient` root, and the contract-bound `ContractClient` — in a Temporal namespace registered for the test file, so parallel test files don't steal each other's tasks:

```typescript
// order.spec.ts
import { createContractTest } from "@temporal-contract/testing/contract";
import { declareActivitiesHandler } from "@temporal-contract/worker/activity";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { describe, expect } from "vitest";

import { orderContract } from "./order.contract.js";

const activities = declareActivitiesHandler({ contract: orderContract, activities: { ... } });

const it = createContractTest({
  contract: orderContract,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./order.workflows.js"), // bundled once per file
  activities, // omit for a workflow-only worker
});

describe("order processing", () => {
  it("processes an order", async ({ client, typedClient, worker, namespace }) => {
    const result = await client.executeWorkflow("processOrder", {
      workflowId: `order-${Date.now()}`,
      args: { orderId: "ORD-1" },
    });
    expect(result.isOk()).toBe(true);
  });
});
```

### Unit-Testing a Single Activity

`runActivity` executes one `AsyncResult`-returning activity implementation inside `@temporalio/testing`'s `MockActivityEnvironment` — no worker, no server, no Docker. Pass your own environment (`env`) to observe heartbeats or trigger cancellation:

```typescript
import { runActivity, runActivityHandler } from "@temporal-contract/testing/activity";

const result = await runActivity(chargeCardDefinition, {
  implementation: chargeCard, // ({ errors, input, idempotencyKey }) => AsyncResult<...>
  input: { amount: 100 },
});
expect(result.isOk()).toBe(true);

// Boundary-faithful: the real handler wrapping, validation on both sides, and a
// payload-converter round trip (override with `payloadConverter`).
const wired = await runActivityHandler(chargeCardDefinition, {
  implementation: chargeCard,
  input: { amount: 100 },
});
```

### Time-Skipping Environment (no Docker)

The `./time-skipping` entry runs suites against Temporal's in-process time-skipping test server (downloaded and cached by `@temporalio/testing` on first use) — hour-long timers resolve instantly:

```typescript
import { it } from "@temporal-contract/testing/time-skipping";
// or pin the server version:
// const it = createTimeSkippingTest({ server: { executable: { type: "cached-download", version: "v1.3.0" } } });

it("processes the order", async ({ testEnv }) => {
  // testEnv.client, testEnv.nativeConnection, worker.runUntil(...)
});
```

`createTimeSkippingContractTest({ contract, workflowsPath, activities })` is the one-call counterpart to `createContractTest`: a bundled worker and the contract-bound `client`, plus a replay of every execution the test started (derived workflow IDs included) when it finishes.

`createTimeSkippingEnvironment(options?)` creates the environment directly for suites preferring explicit `beforeAll`/`afterAll` management.

### Connection Fixtures

Use the `it` extension for automatic connection management against the testcontainers server:

```typescript
// my-workflow.spec.ts
import { it } from "@temporal-contract/testing/extension";
import { Client } from "@temporalio/client";
import { expect } from "vitest";

it("should execute workflow", async ({ clientConnection, workerConnection }) => {
  // clientConnection: Connection from @temporalio/client (auto-connected, auto-closed)
  // workerConnection: NativeConnection from @temporalio/worker (auto-connected, auto-closed)

  const client = new Client({ connection: clientConnection });
  // ... use client and workerConnection in your test
});
```

## Documentation

📖 **[Read the full documentation →](https://btravstack.github.io/temporal-contract)**

- [API Reference](https://btravstack.github.io/temporal-contract/api/testing)
- [Examples](https://btravstack.github.io/temporal-contract/examples/)

## License

MIT
