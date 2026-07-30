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
import {
  TestWorkflowEnvironment,
  type TimeSkippingTestWorkflowEnvironmentOptions,
} from "@temporalio/testing";
import { it as vitestIt } from "vitest";

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
