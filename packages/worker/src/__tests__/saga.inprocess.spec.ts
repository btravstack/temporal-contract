import { CONTRACT_ERROR_TAG } from "@temporal-contract/contract/errors";
import { testRig } from "@temporal-contract/testing/test-rig";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { ErrAsync, OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { declareActivitiesHandler } from "../activity.js";
import { ACTIVITY_ERROR_TAG } from "../error-tags.js";
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
      fulfil: {
        reserve: () => OkAsync({ reservationId: "r-1" }),
        charge: () => OkAsync({ chargeId: "c-1" }),
        ship: ({ errors, input: { mode } }) =>
          mode === "declared"
            ? ErrAsync(errors.OutOfStock({ sku: "s-1" }))
            : // A throw the activity never modeled — it reaches the workflow
              // as an ActivityError, the failure that must NOT compensate.
              // oxlint-disable-next-line unthrown/no-throw -- an unmodelled activity failure is the case under test
              (() => {
                throw new Error("the warehouse is on fire");
              })(),
        release: () => {
          undone.push("release");
          return OkAsync({});
        },
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
