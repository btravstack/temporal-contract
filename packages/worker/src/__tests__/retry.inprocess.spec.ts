import { testRig } from "@temporal-contract/testing/test-rig";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { Context } from "@temporalio/activity";
import { ErrAsync } from "unthrown";
import { describe, expect } from "vitest";

import { declareActivitiesHandler } from "../activity.js";
import { retryContract } from "./retry.contract.js";

const WORKFLOW_EXECUTION_TIMEOUT = "30 seconds";

describe("nonRetryable is a behavior, not a field", () => {
  it("stops after exactly one attempt when the declared error is nonRetryable", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(retryContract, nextTaskQueueId("retry-terminal"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "retry.workflows"));

    const activities = declareActivitiesHandler({
      contract,
      activities: {
        runsFlaky: {
          // Always fails. `Context.current().info.attempt` is Temporal's own
          // attempt counter, so the assertion reads what the server did.
          flaky: (_input, { errors }) =>
            ErrAsync(errors.TerminalFailure({ at: Context.current().info.attempt })),
        },
      },
    });

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    const result = await worker.raw.runUntil(
      client
        .executeWorkflow("runsFlaky", {
          workflowId: "retry-terminal",
          args: { mode: "terminal" },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow(),
    );

    // The whole point: attempt 1 and no more. A regression that dropped
    // `nonRetryable` on the wire would let Temporal retry to 3.
    expect(result).toEqual({ outcome: "err:TerminalFailure", attempts: 1 });
  });

  it("retries when the declared error is retryable", async ({ testEnv }) => {
    const contract = withTaskQueue(retryContract, nextTaskQueueId("retry-retryable"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "retry.workflows"));

    const activities = declareActivitiesHandler({
      contract,
      activities: {
        runsFlaky: {
          flaky: (_input, { errors }) =>
            ErrAsync(errors.RetryableFailure({ at: Context.current().info.attempt })),
        },
      },
    });

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    const result = await worker.raw.runUntil(
      client
        .executeWorkflow("runsFlaky", {
          workflowId: "retry-retryable",
          args: { mode: "retryable" },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow(),
    );

    // Exhausts the declared `maximumAttempts: 3`, so the surfaced failure is
    // from attempt 3 — proving Temporal really retried.
    expect(result).toEqual({ outcome: "err:RetryableFailure", attempts: 3 });
  });
});
