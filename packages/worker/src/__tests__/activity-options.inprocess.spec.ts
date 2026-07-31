import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { TypedClient } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { declareActivitiesHandler } from "../activity.js";
import { TypedWorker } from "../worker.js";
import { activityOptionsContract } from "./activity-options.contract.js";

function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}

describe("contract-level activityOptions reach Temporal", () => {
  it("times out an activity that outlives its startToCloseTimeout", async ({ testEnv }) => {
    const contract = withTaskQueue(activityOptionsContract, nextTaskQueueId("activity-options"));
    const bundle = await bundleFor(workflowPath("activity-options.workflows"));

    const activities = declareActivitiesHandler({
      contract,
      activities: {
        runsActivity: {
          // Outlives the 1s startToCloseTimeout. Uses the activity context's
          // real clock (a real `setTimeout`), which the time-skipping server
          // does not fast-forward — only workflow timers are skipped.
          // `fromSafePromise` (not an `async` function) lifts the delayed
          // promise into an `AsyncResult` without flattening it into
          // `Promise<Result<...>>` on return.
          slowActivity: ({ sleepMs }) =>
            fromSafePromise(
              new Promise<{ done: boolean }>((resolve) => {
                setTimeout(() => resolve({ done: true }), sleepMs);
              }),
            ),
        },
      },
    });

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
      activities,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const outcome = await worker.raw.runUntil(async () => {
      // `.getOrThrow()`, not `.get()`: both calls carry a real (non-`never`)
      // Err channel, and this is a setup step where any Err is unexpected —
      // let it throw and fail the test loudly rather than narrowing.
      const handle = await client
        .startWorkflow("runsActivity", {
          workflowId: "activity-options-timeout",
          args: { sleepMs: 5_000 },
        })
        .getOrThrow();
      return handle.result().getOrThrow();
    });

    // EFFECT assertion: the activity really was cut off by the timeout.
    expect(outcome.outcome).toContain("err:");
  });
});
