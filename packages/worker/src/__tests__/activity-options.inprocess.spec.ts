import { testRig } from "@temporal-contract/testing/test-rig";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { ApplicationFailure } from "@temporalio/common";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { declareActivitiesHandler } from "../activity.js";
import { activityOptionsContract, layeredOptionsContract } from "./activity-options.contract.js";

/**
 * Real `setTimeout`-backed activity body shared by every "outlives its
 * startToCloseTimeout" fixture below. A real (not workflow) timer: the
 * time-skipping server fast-forwards workflow timers and activity retry
 * backoff, but not an activity's own wall-clock work — it can't know how
 * long that work "should" take. So the server's start-to-close timeout
 * fires on schedule while this promise keeps running in the background,
 * logging a harmless `WARN Activity not found on completion` once it
 * finally resolves against a workflow that's already finished. That log
 * line is expected, not a bug — heartbeat-less activities are never
 * notified that they were timed out.
 */
function sleepThenDone({ sleepMs }: { sleepMs: number }) {
  return fromSafePromise(
    new Promise<{ done: boolean }>((resolve) => {
      setTimeout(() => resolve({ done: true }), sleepMs);
    }),
  );
}

describe("contract-level activityOptions reach Temporal", () => {
  it("times out an activity that outlives its startToCloseTimeout", async ({ testEnv }) => {
    const contract = withTaskQueue(activityOptionsContract, nextTaskQueueId("activity-options"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "activity-options.workflows"));

    const activities = declareActivitiesHandler({
      contract,
      activities: {
        // Outlives the 1s startToCloseTimeout, but comfortably: 2s is well
        // past the 1s boundary without paying for a much longer real sleep.
        runsActivity: { slowActivity: sleepThenDone },
      },
    });

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    const outcome = await worker.raw.runUntil(async () => {
      // `.getOrThrow()`, not `.get()`: both calls carry a real (non-`never`)
      // Err channel, and this is a setup step where any Err is unexpected —
      // let it throw and fail the test loudly rather than narrowing.
      const handle = await client
        .startWorkflow("runsActivity", {
          workflowId: "activity-options-timeout",
          args: { sleepMs: 2_000 },
        })
        .getOrThrow();
      return handle.result().getOrThrow();
    });

    // EFFECT assertion: not just "some Err happened" (which an input/output
    // validation failure or an unregistered activity would also produce),
    // but specifically that the *start-to-close timeout* fired — the exact
    // property the contract-level `activityOptions` is supposed to control.
    expect(outcome.outcome).toBe("err:START_TO_CLOSE");
  });
});

describe("activityOptions merge precedence across layers", () => {
  it("resolves each activity's effective options independently of the others", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(layeredOptionsContract, nextTaskQueueId("layered-options"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "activity-options.workflows"));

    let flakyCalls = 0;
    const activities = declareActivitiesHandler({
      contract,
      activities: {
        // Global (contract-level) activity — no workflow scope wraps it.
        globalTimeoutActivity: sleepThenDone,
        resolvesLayeredOptions: {
          contractTimeoutActivity: sleepThenDone,
          usesDefaultActivity: sleepThenDone,
          // Fails on the first attempt, succeeds on the second. Whether a
          // second attempt happens at all is the effect under test — see
          // the doc comment on `flakyActivity` in the contract.
          flakyActivity: () => {
            flakyCalls += 1;
            if (flakyCalls < 2) {
              return ErrAsync(
                ApplicationFailure.create({
                  type: "NotYetSucceeded",
                  message: "fails once on purpose",
                  nonRetryable: false,
                }),
              );
            }
            return OkAsync({ attempts: flakyCalls });
          },
        },
      },
    });

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    const outcome = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("resolvesLayeredOptions", {
          workflowId: "layered-options",
          args: { sleepMs: 2_000 },
        })
        .getOrThrow();
      return handle.result().getOrThrow();
    });

    // Contract-level `activityOptions` wins over the workflow-wide default
    // (30s) — this activity's contract-level 1s timeout still fires.
    expect(outcome.contractTimeout).toBe("err:START_TO_CLOSE");
    // No contract-level options at all: falls back to the workflow-wide
    // default (30s), comfortably outlasting the 2s sleep. Completing here
    // *alongside* `contractTimeout`'s timeout, in the same workflow run,
    // proves per-activity-name routing between the customized and default
    // proxies.
    expect(outcome.usesDefault).toBe("completed");
    // The merge logic is identical for a global (contract-level) activity —
    // not just a workflow-local one.
    expect(outcome.globalTimeout).toBe("err:START_TO_CLOSE");
    // `activityOptionsByName` precedence + shallow merge: the override wins
    // over contract-level `activityOptions` (its `retry` block applies at
    // all) AND does so by replacing that block wholesale rather than
    // deep-merging (the lower layer's `maximumAttempts: 1` does not survive
    // to cap this at one attempt). Either bug would leave this "err:...",
    // never "completed".
    expect(outcome.flaky).toBe("completed");
    expect(flakyCalls).toBe(2);
  });
});
