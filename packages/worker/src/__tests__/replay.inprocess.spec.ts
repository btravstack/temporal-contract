import { testRig } from "@temporal-contract/testing/test-rig";
import { it } from "@temporal-contract/testing/time-skipping";
import { bundleFor, fixturePath } from "@temporal-contract/testing/workflow-bundle";
import { OkAsync, ErrAsync } from "unthrown";
/**
 * Replay-determinism coverage for the Result/AsyncResult machinery inside
 * `declareWorkflow` (in-process, no Docker).
 *
 * `declareWorkflow` implementations run unthrown pipelines — `AsyncResult`
 * activity calls, typed contract-error rehydration, and *async* Standard
 * Schema validation at every payload boundary — inside Temporal's
 * deterministic sandbox. Nothing else proves those constructs replay
 * deterministically: a hidden source of nondeterminism (e.g. an unpatched
 * microtask ordering dependency) would only surface on replay, as a
 * `DeterminismViolationError`, long after the original run went green.
 *
 * This spec runs the full pipeline to completion — one happy path and one
 * typed-activity-error path (ContractError → ApplicationFailure wire shape →
 * rehydration inside the workflow). `testRig`'s `onTestFinished` hook then
 * fetches each started execution's history and replays it with
 * `Worker.runReplayHistory`, which rejects on any determinism violation.
 */
import { describe, expect } from "vitest";

import { declareActivitiesHandler } from "../activity.js";
import { inprocessContract } from "./inprocess.contract.js";

const activities = declareActivitiesHandler({
  contract: inprocessContract,
  activities: {
    placeOrder: {
      charge: ({ amount }, { errors }) => {
        if (amount < 0) {
          return ErrAsync(errors.PaymentDeclined({ reason: "negative-amount" }));
        }
        return OkAsync({ transactionId: `tx-${amount}` });
      },
    },
  },
});

describe("declareWorkflow replay determinism", () => {
  it("replays histories produced by Result-shaped workflows without determinism violations", async ({
    testEnv,
  }) => {
    const { worker, client } = await testRig(testEnv, {
      contract: inprocessContract,
      bundle: await bundleFor(fixturePath(import.meta.url, "inprocess.workflows")),
      activities,
    });

    const happyId = "replay-happy";
    const declinedId = "replay-declined";

    await worker.raw.runUntil(async () => {
      // Happy path: async input/output schema validation + an AsyncResult
      // activity call resolving Ok.
      const charged = await client.executeWorkflow("placeOrder", {
        workflowId: happyId,
        args: { orderId: "ORD-1", amount: 5 },
      });
      expect(charged).toBeOkWith({ status: "charged:tx-5" });

      // Typed error path: the activity's declared error crosses the wire as
      // an ApplicationFailure and is rehydrated into a typed ContractError
      // inside the workflow sandbox (async schema validation on the error
      // data), which the implementation folds into a normal completion.
      const declined = await client.executeWorkflow("placeOrder", {
        workflowId: declinedId,
        args: { orderId: "ORD-2", amount: -1 },
      });
      expect(declined).toBeOkWith({ status: "declined:negative-amount" });
    });
  });
});
