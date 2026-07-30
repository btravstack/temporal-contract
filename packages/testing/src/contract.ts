/**
 * Contract-aware Vitest fixtures over the testcontainers-provided Temporal
 * server.
 *
 * {@link createContractTest} wires the whole integration-test stack for one
 * contract — a running worker, the connection-scoped {@link TypedClient}
 * root, and the contract-bound {@link ContractClient} — on top of the
 * connection fixtures from `./extension` (which read the address provided by
 * `@temporal-contract/testing/global-setup`). Suites destructure exactly
 * what they use:
 *
 * @example
 * ```ts
 * import { createContractTest } from "@temporal-contract/testing/contract";
 * import { declareActivitiesHandler } from "@temporal-contract/worker/activity";
 * import { workflowsPathFromURL } from "@temporal-contract/worker/worker";
 * import { describe, expect } from "vitest";
 *
 * import { orderContract } from "./order.contract.js";
 *
 * const activities = declareActivitiesHandler({ contract: orderContract, activities: { ... } });
 *
 * const it = createContractTest(orderContract, {
 *   workflowsPath: workflowsPathFromURL(import.meta.url, "./order.workflows.js"),
 *   activities,
 * });
 *
 * describe("order processing", () => {
 *   it("processes an order end-to-end", async ({ client }) => {
 *     const result = await client.executeWorkflow("processOrder", {
 *       workflowId: `order-${Date.now()}`,
 *       args: { orderId: "ORD-1" },
 *     });
 *     expect(result.isOk()).toBe(true);
 *   });
 * });
 * ```
 */
import { TypedClient, type ContractClient } from "@temporal-contract/client";
import type { ContractDefinition } from "@temporal-contract/contract";
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";
import { createWorker, type CreateWorkerOptions } from "@temporal-contract/worker/worker";
import { Client } from "@temporalio/client";
import type { Worker } from "@temporalio/worker";
import { vi } from "vitest";

import { it as baseIt } from "./extension.js";

/**
 * Options for {@link createContractTest}.
 */
export type CreateContractTestOptions<TContract extends ContractDefinition> = {
  /**
   * Path to the workflows file registered on the worker — typically built
   * with `workflowsPathFromURL(import.meta.url, "./x.workflows.js")` from
   * `@temporal-contract/worker/worker`.
   */
  workflowsPath: string;
  /**
   * Activities handler built with `declareActivitiesHandler`. Omit it for a
   * workflow-only worker.
   */
  activities?: ActivitiesHandler<TContract>;
  /**
   * Extra options forwarded to `createWorker` (e.g. `namespace`,
   * interceptors, tuning knobs). The `namespace`, when given, is also used
   * by the client fixtures.
   */
  workerOptions?: Omit<
    CreateWorkerOptions<TContract>,
    "activities" | "connection" | "contract" | "workflowsPath"
  >;
};

/**
 * Fixture context exposed by the `it` returned from
 * {@link createContractTest}.
 */
export type ContractTestContext<TContract extends ContractDefinition> = {
  /** Contract-bound client — `typedClient.for(contract)`. */
  client: ContractClient<TContract>;
  /**
   * Connection-scoped root, for binding further contracts or reaching the
   * `raw` escape hatch.
   */
  typedClient: TypedClient;
  /**
   * The running worker for the contract's task queue — created and started
   * before the test (`auto`), shut down after it.
   */
  worker: Worker;
};

/**
 * Build a Vitest `it` whose fixtures run the given contract against the
 * testcontainers-provided Temporal server: a worker on the contract's task
 * queue (started before each test, shut down after), the connection-scoped
 * {@link TypedClient} root, and the contract-bound {@link ContractClient}.
 *
 * Requires the `@temporal-contract/testing/global-setup` global setup (or a
 * module default-exporting `createGlobalSetup(...)`) to be registered on the
 * test project. The underlying `clientConnection`/`workerConnection`
 * fixtures from `./extension` remain available on the context.
 */
export function createContractTest<TContract extends ContractDefinition>(
  contract: TContract,
  options: CreateContractTestOptions<TContract>,
) {
  return baseIt.extend<ContractTestContext<TContract>>({
    worker: [
      async ({ workerConnection }, use) => {
        // Technical creation failures ride the defect channel (E = never);
        // `get()` unwraps directly and rethrows a defect's cause.
        const worker = await createWorker({
          contract,
          connection: workerConnection,
          workflowsPath: options.workflowsPath,
          ...(options.activities !== undefined ? { activities: options.activities } : {}),
          ...options.workerOptions,
        }).get();

        const runPromise = worker.run();
        // Handled here so a mid-test worker crash doesn't trip Node's
        // unhandled-rejection reporting; the real failure resurfaces at the
        // `await runPromise` below.
        runPromise.catch(() => {});

        await vi.waitFor(() => worker.getState() === "RUNNING", { interval: 100 });

        await use(worker);

        if (worker.getState() === "RUNNING") {
          worker.shutdown();
        }
        // Resolves once shutdown completes — or rejects with the original
        // error when the worker failed, surfacing it as a teardown failure.
        await runPromise;
      },
      { auto: true },
    ],
    typedClient: async ({ clientConnection }, use) => {
      const namespace = options.workerOptions?.namespace;
      const client = new Client({
        connection: clientConnection,
        ...(namespace !== undefined ? { namespace } : {}),
      });
      // Setup faults are defects (E = never); `get()` unwraps directly.
      const typedClient = await TypedClient.create({ client }).get();
      await use(typedClient);
    },
    client: async ({ typedClient }, use) => {
      await use(typedClient.for(contract));
    },
  });
}
