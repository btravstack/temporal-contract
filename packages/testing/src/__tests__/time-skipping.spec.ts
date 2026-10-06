import { setTimeout } from "node:timers/promises";

/**
 * Integration coverage for `createTimeSkippingContractTest` (and the
 * `testRig` under it) against a real time-skipping server.
 */
import { declareActivitiesHandler } from "@temporal-contract/worker/activity";
import { fromSafePromise, OkAsync } from "unthrown";
import { describe, expect, onTestFinished, vi } from "vitest";

import { createTimeSkippingContractTest } from "../time-skipping.js";
import { fixturePath } from "../workflow-bundle.js";
import { testContract } from "./test.contract.js";

// `"slow"` keeps the activity in flight past a shutdown, holding the worker
// in a draining state.
const decorate = ({ input: { name } }: { input: { name: string } }) =>
  name === "slow"
    ? fromSafePromise(setTimeout(1_000, { decorated: name }))
    : OkAsync({ decorated: name.toUpperCase() });

const it = createTimeSkippingContractTest({
  contract: testContract,
  workflowsPath: fixturePath(import.meta.url, "test.workflows"),
  activities: declareActivitiesHandler({
    contract: testContract,
    activities: { greet: { decorate }, greetDerived: { decorate } },
  }),
  replaySkipAllowlist: {
    "draining-": "stopped mid-activity to hold the worker in a draining state",
  },
});

describe("createTimeSkippingContractTest", () => {
  it("records and replays a workflow whose contract derives its ID", async ({ worker, client }) => {
    const result = await worker.raw.runUntil(async () =>
      client.executeWorkflow("greetDerived", { args: { name: "derived" } }),
    );

    expect(result).toBeOkWith({ message: "Hello, DERIVED!" });
  });

  it("waits for a worker the test left draining before tearing down", async ({
    worker,
    client,
  }) => {
    void worker.run();
    await vi.waitUntil(() => worker.raw.getState() === "RUNNING");
    await client.startWorkflow("greet", { workflowId: "draining-1", args: { name: "slow" } });
    await vi.waitUntil(() => worker.raw.getStatus().numInFlightActivities > 0);
    worker.shutdown().get();
    expect(worker.raw.getState()).not.toBe("STOPPED");

    // Runs after the fixture teardown, which must have waited the drain out:
    // a worker still holding the environment's connection makes its
    // teardown fail.
    onTestFinished(() => {
      expect(worker.raw.getState()).toBe("STOPPED");
    });
  });
});
