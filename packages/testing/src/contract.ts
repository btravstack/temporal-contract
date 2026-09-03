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
 * const it = createContractTest({
 *   contract: orderContract,
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
 *     await expect(result).toBeOk(); // with @unthrown/vitest matchers
 *   });
 * });
 * ```
 */
import { TypedClient, type ContractClient } from "@temporal-contract/client";
import type { ContractDefinition } from "@temporal-contract/contract";
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";
import { TypedWorker, type CreateWorkerOptions } from "@temporal-contract/worker/worker";
import { Client } from "@temporalio/client";
import { vi } from "vitest";

import { it as baseIt } from "./extension.js";

/**
 * Options for {@link createContractTest}.
 */
export type CreateContractTestOptions<TContract extends ContractDefinition> = {
  /** The contract under test — its task queue names the worker's queue. */
  contract: TContract;
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
   * Extra options forwarded to `TypedWorker.create` (e.g. `namespace`,
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
   * before the test (`auto`), shut down after it. The underlying Temporal
   * `Worker` stays reachable via `worker.raw`.
   */
  worker: TypedWorker;
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
  options: CreateContractTestOptions<TContract>,
) {
  const { contract } = options;
  return baseIt.extend<ContractTestContext<TContract>>({
    worker: [
      async ({ workerConnection }, use) => {
        // E is `never` here — see "Setup calls have an empty Err channel" in
        // docs/explanation/the-result-model.md.
        const worker = await TypedWorker.create({
          contract,
          connection: workerConnection,
          workflowsPath: options.workflowsPath,
          ...(options.activities !== undefined ? { activities: options.activities } : {}),
          ...options.workerOptions,
        }).get();

        // `run()` returns `AsyncResult<void, never>` whose internal promise
        // never rejects, so holding onto it across the test cannot trip
        // Node's unhandled-rejection reporting; a mid-test worker crash
        // resurfaces at the `.get()` below.
        const running = worker.run();

        await vi.waitFor(() => worker.raw.getState() === "RUNNING", { interval: 100 });

        await use(worker);

        if (worker.raw.getState() === "RUNNING") {
          worker.shutdown();
        }
        // Resolves once shutdown completes — or rethrows the original
        // failure's cause when the worker crashed, surfacing it as a
        // teardown failure.
        await running.get();
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
