import { CONTRACT_ERROR_TAG } from "@temporal-contract/contract/errors";
import { testRig } from "@temporal-contract/testing/test-rig";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { Context } from "@temporalio/activity";
import { ErrAsync, fromSafePromise, OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { declareActivitiesHandler } from "../activity.js";
import { ACTIVITY_CANCELLED_ERROR_TAG, ACTIVITY_ERROR_TAG } from "../error-tags.js";
import { sagaContract } from "./saga.contract.js";

const WORKFLOW_EXECUTION_TIMEOUT = "30 seconds";

/**
 * One rig per case: the compensation activities record themselves, so what
 * ran is read off `undone` rather than inferred from the workflow's answer.
 */
const rigFor = async (testEnv: Parameters<typeof testRig>[0], label: string) => {
  const contract = withTaskQueue(sagaContract, nextTaskQueueId(label));
  const bundle = await bundleFor(fixturePath(import.meta.url, "saga.workflows"));
  const undone: string[] = [];

  const activities = declareActivitiesHandler({
    contract,
    activities: {
      reserve: () => OkAsync({ reservationId: "r-1" }),
      charge: () => OkAsync({ chargeId: "c-1" }),
      release: () => {
        undone.push("release");
        return OkAsync({});
      },
      fulfil: {
        ship: ({ errors, input: { mode } }) =>
          mode === "declared"
            ? ErrAsync(errors.OutOfStock({ sku: "s-1" }))
            : // A throw the activity never modeled — it reaches the workflow
              // as an ActivityError, the failure that must NOT compensate.
              // oxlint-disable-next-line unthrown/no-throw -- an unmodelled activity failure is the case under test
              (() => {
                throw new Error("the warehouse is on fire");
              })(),
        refund: () => {
          undone.push("refund");
          return OkAsync({});
        },
      },
    },
  });

  const { worker, client } = await testRig(testEnv, { contract, bundle, activities });
  return { worker, client, undone };
};

describe("the workflow saga, inside the sandbox", () => {
  it("unwinds LIFO when the last step answers a declared contract error", async ({ testEnv }) => {
    // GIVEN a three-step fulfilment whose last step is out of stock
    const { worker, client, undone } = await rigFor(testEnv, "saga-declared");

    // WHEN the workflow runs
    const result = await worker.raw.runUntil(
      client
        .executeWorkflow("fulfil", {
          workflowId: "saga-declared",
          args: { mode: "declared" },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow(),
    );

    // THEN both earned undos ran newest-first, and the failure came back as it was
    expect({ ...result, undone }).toEqual({
      failedWith: CONTRACT_ERROR_TAG,
      undone: ["refund", "release"],
    });
  });

  it("leaves the earlier steps standing when the last one fails unmodelled", async ({
    testEnv,
  }) => {
    // GIVEN the same fulfilment, whose last step fails in a way nobody declared
    const { worker, client, undone } = await rigFor(testEnv, "saga-unmodelled");

    // WHEN the workflow runs
    const result = await worker.raw.runUntil(
      client
        .executeWorkflow("fulfil", {
          workflowId: "saga-unmodelled",
          args: { mode: "unmodelled" },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow(),
    );

    // THEN nothing was taken back — that step's state is not knowable
    expect({ ...result, undone }).toEqual({ failedWith: ACTIVITY_ERROR_TAG, undone: [] });
  });
});

/**
 * A cancellation-aware `charge`: it blocks until the workflow is cancelled.
 * Heartbeating is what lets `context.cancelled` ever reject — Temporal
 * delivers the notification in a heartbeat RPC's response.
 */
const cancellableCharge = ({ sleepMs }: { sleepMs: number }) => {
  const context = Context.current();
  return fromSafePromise(async () => {
    const heartbeat = setInterval(() => context.heartbeat(), 100);
    // Held so the loser of the race is cleared too: cancellation wins here by
    // design, and an uncleared 30s timer would outlive the test.
    let sleeping: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          sleeping = setTimeout(resolve, sleepMs);
        }),
        context.cancelled,
      ]);
      return { chargeId: "c-1" };
    } finally {
      clearInterval(heartbeat);
      clearTimeout(sleeping);
    }
  });
};

describe("the workflow saga, compensating on cancellation", () => {
  it("still runs the undo when the step was cancelled and the caller opted in", async ({
    testEnv,
  }) => {
    // GIVEN a saga whose second step blocks, with compensateOnCancellation
    const contract = withTaskQueue(sagaContract, nextTaskQueueId("saga-cancelled"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "saga.workflows"));
    const undone: string[] = [];
    // `startWorkflow` returns once the start request is accepted, which is
    // well before `reserve` finishes. Cancelling then would cancel step ONE,
    // where no undo has been earned yet — a different case than the one under
    // test, and a flaky one.
    let chargeStarted!: () => void;
    const chargeIsRunning = new Promise<void>((resolve) => {
      chargeStarted = resolve;
    });

    const activities = declareActivitiesHandler({
      contract,
      activities: {
        reserve: () => OkAsync({ reservationId: "r-1" }),
        charge: ({ input }) => {
          chargeStarted();
          return cancellableCharge(input);
        },
        release: () => {
          undone.push("release");
          return OkAsync({});
        },
        // Unused here; the handler covers the whole contract.
        fulfil: {
          ship: () => OkAsync({ shipmentId: "sh-1" }),
          refund: () => OkAsync({}),
        },
      },
    });

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    // WHEN the workflow is cancelled while the second step is in flight
    const outcome = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("fulfilUntilCancelled", {
          workflowId: "saga-cancelled",
          args: {},
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();
      await chargeIsRunning;
      await handle.cancel().getOrThrow();
      return handle.result();
    });

    // THEN the earned undo ran — from a non-cancellable scope, since a
    // cancelled scope schedules no activity at all
    expect({ outcome: outcome.isOk() ? outcome.value : outcome, undone }).toEqual({
      outcome: { failedWith: ACTIVITY_CANCELLED_ERROR_TAG },
      undone: ["release"],
    });
  });
});
