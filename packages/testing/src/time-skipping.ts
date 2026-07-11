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
 * import { createWorker } from "@temporal-contract/worker/worker";
 * import { TypedClient } from "@temporal-contract/client";
 *
 * it("processes the order", async ({ testEnv }) => {
 *   const worker = await createWorker({
 *     contract: myContract,
 *     connection: testEnv.nativeConnection,
 *     workflowsPath: workflowsPathFromURL(import.meta.url, "./test.workflows.js"),
 *     activities,
 *   }).getOrElse((error) => {
 *     throw error;
 *   });
 *   const client = await TypedClient.create({ contract: myContract, client: testEnv.client }).getOrElse((error) => {
 *     throw error;
 *   });
 *
 *   await worker.runUntil(async () => {
 *     const result = await client.executeWorkflow("processOrder", {
 *       workflowId: "order-1",
 *       args: { orderId: "ORD-1" },
 *     });
 *     expect(result).toBeOk();
 *   });
 * });
 * ```
 */
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { it as vitestIt } from "vitest";

/**
 * Create a time-skipping `TestWorkflowEnvironment` directly — for suites
 * that prefer explicit `beforeAll`/`afterAll` management over the {@link it}
 * fixture (remember to call `env.teardown()`).
 */
export function createTimeSkippingEnvironment(): Promise<TestWorkflowEnvironment> {
  return TestWorkflowEnvironment.createTimeSkipping();
}

export const it = vitestIt.extend<{
  $worker: { testEnv: TestWorkflowEnvironment };
}>({
  testEnv: [
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const env = await TestWorkflowEnvironment.createTimeSkipping();
      await use(env);
      await env.teardown();
    },
    { scope: "worker" },
  ],
});
