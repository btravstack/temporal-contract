import { TypedClient, type ContractClient } from "@temporal-contract/client";
import { it as baseIt } from "@temporal-contract/testing/extension";
import { fixturePath } from "@temporal-contract/testing/workflow-bundle";
import { Client } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { OkAsync } from "unthrown";
/**
 * E2e proof that an `activityOptionsByName` entry with a `taskQueue`
 * override actually routes the activity to that queue (the documented
 * split-worker-pool feature) — against the testcontainers Temporal server.
 *
 * Topology:
 * - a **workflow-only** `TypedWorker` polls the contract's task queue
 *   (`routing-workflow-q`) and registers NO activities;
 * - a raw activity worker polls the dedicated `routing-activity-q` and is
 *   the only place the `reportQueue` implementation exists.
 *
 * The workflow can therefore only complete if the activity task was
 * dispatched to the dedicated queue: without the override the task would sit
 * unpolled on the workflow queue and the execution would hang (test
 * timeout).
 */
import { describe, expect, vi } from "vitest";

import { declareActivitiesHandler } from "../activity.js";
import { TypedWorker } from "../worker.js";
import { ROUTED_ACTIVITY_QUEUE, routingContract } from "./routing.contract.js";

const activities = declareActivitiesHandler({
  contract: routingContract,
  activities: {
    routedFlow: {
      reportQueue: () => OkAsync({ handledBy: ROUTED_ACTIVITY_QUEUE }),
    },
  },
});

const it = baseIt.extend<{
  workflowWorker: TypedWorker;
  activityWorker: Worker;
  client: ContractClient<typeof routingContract>;
}>({
  // Workflow-only worker on the contract's queue — deliberately registers no
  // activities, so it cannot satisfy the activity task itself.
  workflowWorker: [
    async ({ workerConnection }, use) => {
      const worker = await TypedWorker.create({
        contract: routingContract,
        connection: workerConnection,
        namespace: "default",
        workflowsPath: fixturePath(import.meta.url, "routing.workflows"),
      }).get();

      const running = worker.run();
      await vi.waitFor(() => worker.raw.getState() === "RUNNING", { interval: 100 });

      await use(worker);

      worker.shutdown();
      await running.get();
    },
    { auto: true },
  ],
  // Activity-only worker polling the routing target queue — the sole
  // registrant of the `reportQueue` implementation.
  activityWorker: [
    async ({ workerConnection }, use) => {
      const worker = await Worker.create({
        connection: workerConnection,
        namespace: "default",
        taskQueue: ROUTED_ACTIVITY_QUEUE,
        activities,
      });

      const running = worker.run();
      await vi.waitFor(() => worker.getState() === "RUNNING", { interval: 100 });

      await use(worker);

      worker.shutdown();
      await running;
    },
    { auto: true },
  ],
  client: async ({ clientConnection }, use) => {
    const rawClient = new Client({ connection: clientConnection, namespace: "default" });
    const root = await TypedClient.create({ client: rawClient }).get();
    await use(root.for(routingContract));
  },
});

describe("activityOptionsByName taskQueue routing", () => {
  it("routes the overridden activity to its dedicated queue end-to-end", async ({ client }) => {
    const result = await client.executeWorkflow("routedFlow", {
      workflowId: `routing-${Date.now()}`,
      args: {},
    });

    expect(result).toBeOkWith({ handledBy: ROUTED_ACTIVITY_QUEUE });
  });
});
