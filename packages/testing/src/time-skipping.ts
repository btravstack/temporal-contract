/**
 * In-process, Docker-free testing via Temporal's time-skipping
 * `TestWorkflowEnvironment`.
 *
 * Complements the testcontainers story (`./global-setup` + `./extension`):
 * the time-skipping server is a lightweight local binary (downloaded and
 * cached by `@temporalio/testing` on first use) that fast-forwards timers, so
 * contract/handler tests — validation on both sides, middleware, typed
 * contract errors, rehydration — run in seconds without a real cluster.
 * Reach for the testcontainers fixtures when you need real-server semantics
 * (visibility/search attributes, schedules, retention).
 *
 * The environment is created once per Vitest worker process (`scope:
 * "worker"`) and torn down when the worker exits — spawning the test server
 * per test would dominate the suite's runtime.
 *
 * @example
 * ```ts
 * import { it } from "@temporal-contract/testing/time-skipping";
 * import { TypedWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";
 * import { TypedClient } from "@temporal-contract/client";
 *
 * it("processes the order", async ({ testEnv }) => {
 *   const worker = await TypedWorker.create({
 *     contract: myContract,
 *     connection: testEnv.nativeConnection,
 *     workflowsPath: workflowsPathFromURL(import.meta.url, "./test.workflows.js"),
 *     activities,
 *   }).get();
 *   const typedClient = await TypedClient.create({ client: testEnv.client }).get();
 *   const client = typedClient.for(myContract);
 *
 *   await worker.raw.runUntil(async () => {
 *     const result = await client.executeWorkflow("processOrder", {
 *       workflowId: "order-1",
 *       args: { orderId: "ORD-1" },
 *     });
 *     expect(result).toBeOk();
 *   });
 * });
 * ```
 */
import type { ContractClient } from "@temporal-contract/client";
import type { ContractDefinition } from "@temporal-contract/contract";
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";
import type { TypedWorker } from "@temporal-contract/worker/worker";
import {
  TestWorkflowEnvironment,
  type TimeSkippingTestWorkflowEnvironmentOptions,
} from "@temporalio/testing";
import type { WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { it as vitestIt } from "vitest";

import { testRig } from "./test-rig.js";
import { bundleFor } from "./workflow-bundle.js";

/**
 * Create a time-skipping `TestWorkflowEnvironment` directly — for suites
 * that prefer explicit `beforeAll`/`afterAll` management over the {@link it}
 * fixture (remember to call `env.teardown()`). Options are forwarded to
 * `TestWorkflowEnvironment.createTimeSkipping` unchanged (e.g. to pin the
 * test-server version via `server.executable`).
 */
export function createTimeSkippingEnvironment(
  options?: TimeSkippingTestWorkflowEnvironmentOptions,
): Promise<TestWorkflowEnvironment> {
  return TestWorkflowEnvironment.createTimeSkipping(options);
}

/**
 * Build a Vitest `it` with a worker-scoped `testEnv` fixture backed by a
 * time-skipping environment created with the given options — use this
 * instead of the ready-made {@link it} when a suite needs to pin the test
 * server version or otherwise configure the environment:
 *
 * @example
 * ```ts
 * import { createTimeSkippingTest } from "@temporal-contract/testing/time-skipping";
 *
 * const it = createTimeSkippingTest({
 *   server: { executable: { type: "cached-download", version: "v1.3.0" } },
 * });
 *
 * it("runs against the pinned server", async ({ testEnv }) => { ... });
 * ```
 */
export function createTimeSkippingTest(options?: TimeSkippingTestWorkflowEnvironmentOptions) {
  return vitestIt.extend<{
    testEnv: TestWorkflowEnvironment;
  }>({
    testEnv: [
      // oxlint-disable-next-line no-empty-pattern
      async ({}, use) => {
        const env = await TestWorkflowEnvironment.createTimeSkipping(options);
        await use(env);
        await env.teardown();
      },
      { scope: "worker" },
    ],
  });
}

/**
 * Ready-made `it` with the worker-scoped `testEnv` fixture and default
 * environment options — {@link createTimeSkippingTest} with no arguments.
 *
 * @public consumed from sibling packages' suites; the tsconfig `paths`
 * indirection hides that usage from knip.
 */
export const it = createTimeSkippingTest();

/**
 * Options for {@link createTimeSkippingContractTest}.
 */
export type CreateTimeSkippingContractTestOptions<TContract extends ContractDefinition> = {
  /** The contract under test — its task queue names the worker's queue. */
  contract: TContract;
  /**
   * Path to the workflows file to bundle — typically built with
   * `workflowsPathFromURL(import.meta.url, "./x.workflows.js")` from
   * `@temporal-contract/worker/worker`, or `fixturePath` from
   * `@temporal-contract/testing/workflow-bundle`.
   */
  workflowsPath: string;
  /** Activities handler built with `declareActivitiesHandler`. Omit it for a workflow-only worker. */
  activities?: ActivitiesHandler<TContract>;
  /**
   * Workflow-ID prefixes whose executions are deliberately left non-terminal,
   * with a reason — forwarded to {@link testRig}, which fails a test that
   * leaves an unlisted execution unreplayable.
   */
  replaySkipAllowlist?: Readonly<Record<string, string>>;
  /** Forwarded to `TestWorkflowEnvironment.createTimeSkipping`. */
  environment?: TimeSkippingTestWorkflowEnvironmentOptions;
};

/**
 * The one-call fixture for the **time-skipping** tier: a bundled worker, the
 * contract-bound client, and the replay-on-finish check, with no Docker and
 * no server to run.
 *
 * The counterpart to `createContractTest` from
 * `@temporal-contract/testing/contract`, which wires the same stack against
 * the testcontainers-provided real server. Reach for that one when a test
 * needs what only a real cluster has — visibility, search attributes,
 * schedules, retention; reach for this one for everything else, which is
 * most workflow tests.
 *
 * The environment and the workflow bundle are **worker-scoped** (built once
 * per Vitest worker process, since bundling dominates the runtime); the
 * worker and client are per-test.
 *
 * Like {@link testRig}, this deliberately does **not** scope the task queue:
 * a same-workflow continue-as-new must land on the contract's static queue,
 * because the contract is closed over inside the bundled workflow module and
 * a test-side copy can never reach it. Suites needing isolation keep calling
 * `withTaskQueue` themselves.
 *
 * @example
 * ```ts
 * import { createTimeSkippingContractTest } from "@temporal-contract/testing/time-skipping";
 * import { workflowsPathFromURL } from "@temporal-contract/worker/worker";
 * import { describe, expect } from "vitest";
 *
 * const it = createTimeSkippingContractTest({
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
 *     await expect(result).toBeOk();
 *   });
 * });
 * ```
 */
export function createTimeSkippingContractTest<TContract extends ContractDefinition>(
  options: CreateTimeSkippingContractTestOptions<TContract>,
) {
  return createTimeSkippingTest(options.environment).extend<{
    bundle: WorkflowBundleWithSourceMap;
    rig: { worker: TypedWorker; client: ContractClient<TContract> };
    worker: TypedWorker;
    client: ContractClient<TContract>;
  }>({
    bundle: [
      // oxlint-disable-next-line no-empty-pattern
      async ({}, use) => {
        await use(await bundleFor(options.workflowsPath));
      },
      { scope: "worker" },
    ],
    // One rig per test: `testRig` builds the worker and the client together
    // (the client is a Proxy over the bound one, recording started IDs for
    // the replay-on-finish check), so they cannot be built independently.
    rig: async ({ testEnv, bundle }, use) => {
      const rig = await testRig(testEnv, {
        contract: options.contract,
        bundle,
        ...(options.activities !== undefined ? { activities: options.activities } : {}),
        ...(options.replaySkipAllowlist !== undefined
          ? { replaySkipAllowlist: options.replaySkipAllowlist }
          : {}),
      });

      await use(rig);

      // A worker still holding the environment's native connection makes the
      // worker-scoped `testEnv` teardown fail with "Cannot close connection
      // while Workers hold a reference to it". Two states can reach here:
      //
      // - `INITIALIZED` — the test never ran the worker. `runUntil` on an
      //   already-resolved promise starts and immediately stops it, which is
      //   the only way to release the reference from this state
      //   (`shutdown()` throws unless the worker is `RUNNING`).
      // - `RUNNING` — the test started it with `run()` and did not stop it.
      //   `shutdown()` is the documented way out, and is what
      //   `createContractTest` does.
      //
      // A test that used `runUntil` is already `STOPPED` and skips both.
      const state = rig.worker.raw.getState();
      if (state === "INITIALIZED") {
        await rig.worker.raw.runUntil(Promise.resolve());
      } else if (state === "RUNNING") {
        rig.worker.shutdown();
      }
    },
    worker: async ({ rig }, use) => {
      await use(rig.worker);
    },
    client: async ({ rig }, use) => {
      await use(rig.client);
    },
  });
}
