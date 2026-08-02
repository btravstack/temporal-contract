import { testRig } from "@temporal-contract/testing/test-rig";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { Context } from "@temporalio/activity";
import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { declareActivitiesHandler } from "../activity.js";
import { timeoutsContract } from "./timeouts.contract.js";

const WORKFLOW_EXECUTION_TIMEOUT = "30 seconds";

describe("activity timeouts reach Temporal through every merge layer", () => {
  it("materializes the value each layer contributed", async ({ testEnv }) => {
    const contract = withTaskQueue(timeoutsContract, nextTaskQueueId("timeouts"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "timeouts.workflows"));

    const activities = declareActivitiesHandler({
      contract,
      activities: {
        reportsLayered: {
          // Reads what Temporal actually scheduled the task with, rather than
          // what we passed in — an effect, not a call shape.
          reportsTimeouts: () => {
            const info = Context.current().info;
            return OkAsync({
              startToCloseMs: info.startToCloseTimeoutMs,
              scheduleToCloseMs: info.scheduleToCloseTimeoutMs,
              // `heartbeatTimeoutMs` is optional on ActivityInfo — 0
              // distinguishes "declared but lost in the merge" from "never
              // declared", so the assertion below fails loudly either way.
              heartbeatMs: info.heartbeatTimeoutMs ?? 0,
            });
          },
        },
      },
    });

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    const result = await worker.raw.runUntil(
      client
        .executeWorkflow("reportsLayered", {
          workflowId: "timeouts-layered",
          args: {},
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow(),
    );

    expect(result).toEqual({
      startToCloseMs: 9_000, // contributed by activityOptionsByName
      scheduleToCloseMs: 20_000, // declareWorkflow's workflow-wide default
      heartbeatMs: 7_000, // contract-level, the layer with no competitor
    });
  });
});
