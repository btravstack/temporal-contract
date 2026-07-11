# Testing

`@temporal-contract/testing` covers two complementary levels:

| Level                        | Entry points                   | Needs Docker | Reach for it when                                                                                                                              |
| ---------------------------- | ------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Contract / handler tests** | `/time-skipping`               | No           | Validating the contract pipeline — validation on both sides, middleware, typed contract errors, rehydration — fast, with timers fast-forwarded |
| **Real-server integration**  | `/global-setup` + `/extension` | Yes          | You need real-cluster semantics: visibility/search attributes, schedules, retention                                                            |

## Contract / handler tests (no Docker)

`@temporal-contract/testing/time-skipping` wraps Temporal's
[`TestWorkflowEnvironment`](https://typescript.temporal.io/api/classes/testing.TestWorkflowEnvironment)
in a Vitest fixture. The time-skipping server is a lightweight local binary
(downloaded and cached by `@temporalio/testing` on first use) that
fast-forwards timers — an hour-long `sleep` resolves immediately — so full
contract-pipeline tests run in seconds. The environment is created once per
Vitest worker process and torn down automatically.

```typescript
import { it } from "@temporal-contract/testing/time-skipping";
import { TypedClient } from "@temporal-contract/client";
import { createWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";

it("processes the order", async ({ testEnv }) => {
  const worker = await createWorker({
    contract: myContract,
    connection: testEnv.nativeConnection,
    workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
    activities,
  }).getOrElse((error) => {
    throw error;
  });
  const client = await TypedClient.create({
    contract: myContract,
    client: testEnv.client,
  }).getOrElse((error) => {
    throw error;
  });

  await worker.runUntil(async () => {
    const result = await client.executeWorkflow("processOrder", {
      workflowId: "order-1",
      args: { orderId: "ORD-1" },
    });
    expect(result).toBeOk();
  });
});
```

`createTimeSkippingEnvironment()` is exported alongside for suites that
prefer explicit `beforeAll`/`afterAll` management.

## Real-server integration

The testcontainers fixtures give you integration tests against a **real
Temporal server** — no mocks — started automatically in Docker via
[testcontainers](https://testcontainers.com/).

## Requirements

- **Vitest 4+** — declared as a peer dependency
- **Docker** — the global setup starts PostgreSQL + Temporal containers
- **ESM** — the package is ESM-only (no `require` support)
- `@temporalio/client` and `@temporalio/worker` — peer dependencies used by
  the connection fixtures

```bash
pnpm add -D @temporal-contract/testing vitest
```

## Wiring Vitest

The package has two entry points:

- `@temporal-contract/testing/global-setup` — a Vitest `globalSetup` hook
  that starts the Temporal server once for the whole test run and provides
  its address to your tests
- `@temporal-contract/testing/extension` — an extended `it` with
  `clientConnection` / `workerConnection` fixtures wired to that server

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "@temporal-contract/testing/global-setup",
  },
});
```

## Writing a test

Extend the provided `it` with your own worker and client fixtures:

```typescript
// integration.spec.ts
import { describe, expect, vi } from "vitest";
import { Worker } from "@temporalio/worker";
import { Client } from "@temporalio/client";
import { TypedClient } from "@temporal-contract/client";
import { it as baseIt } from "@temporal-contract/testing/extension";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { myContract } from "./contract.js";
import { activities } from "./activities.js";

const it = baseIt.extend<{
  worker: Worker;
  client: TypedClient<typeof myContract>;
}>({
  worker: [
    async ({ workerConnection }, use) => {
      const worker = await Worker.create({
        connection: workerConnection,
        namespace: "default",
        taskQueue: myContract.taskQueue,
        workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
        activities,
      });

      worker.run().catch((err) => console.error("Worker failed:", err));
      await vi.waitFor(() => worker.getState() === "RUNNING", { interval: 100 });

      await use(worker);

      worker.shutdown();
      await vi.waitFor(() => worker.getState() === "STOPPED", { interval: 100 });
    },
    { auto: true }, // start the worker even for tests that don't reference it
  ],
  client: async ({ clientConnection }, use) => {
    const rawClient = new Client({ connection: clientConnection, namespace: "default" });
    await use(
      await TypedClient.create({ contract: myContract, client: rawClient }).getOrElse((error) => {
        throw error;
      }),
    );
  },
});

describe("processOrder", () => {
  it("completes an order end-to-end", async ({ client }) => {
    const result = await client.executeWorkflow("processOrder", {
      workflowId: `order-${Date.now()}`,
      args: { orderId: "ORD-1", customerId: "CUST-1" },
    });

    expect(result.isOk()).toBe(true);
  });
});
```

The `clientConnection` fixture is closed automatically after each test; the
`workerConnection` fixture's cleanup is left to the test framework.

## How it works

`global-setup` starts a PostgreSQL container and a `temporalio/auto-setup`
Temporal container on a shared network, waits for their health checks, and
calls Vitest's `provide()` with the server address. The `it` fixtures read
that address with `inject()` and open connections against it. Everything is
torn down when the test run ends.

A complete, runnable version of this setup lives in the repository's
[`examples/order-processing-worker`](https://github.com/btravstack/temporal-contract/tree/main/examples/order-processing-worker)
(`vitest.config.ts` + `src/integration.spec.ts`).
