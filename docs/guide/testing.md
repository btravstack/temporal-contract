# Testing

`@temporal-contract/testing` gives you integration tests against a **real
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
    await use(TypedClient.create(myContract, rawClient));
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
