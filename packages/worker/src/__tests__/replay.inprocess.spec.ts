import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { TypedClient } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import { Worker } from "@temporalio/worker";
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
 * rehydration inside the workflow) — fetches each execution's history, and
 * replays it with `Worker.runReplayHistory`, which rejects on any
 * determinism violation.
 */
import { describe, expect } from "vitest";

import { declareActivitiesHandler } from "../activity.js";
import { TypedWorker } from "../worker.js";
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

function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}

describe("declareWorkflow replay determinism", () => {
  it("replays histories produced by Result-shaped workflows without determinism violations", async ({
    testEnv,
  }) => {
    const worker = await TypedWorker.create({
      contract: inprocessContract,
      connection: testEnv.nativeConnection,
      workflowsPath: workflowPath("inprocess.workflows"),
      activities,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(inprocessContract);

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

    // Replay both histories against the same workflow code.
    // `runReplayHistory` rejects with a DeterminismViolationError (or
    // ReplayError) if the unthrown machinery diverges on replay.
    for (const workflowId of [happyId, declinedId]) {
      const history = await testEnv.client.workflow.getHandle(workflowId).fetchHistory();
      await expect(
        Worker.runReplayHistory(
          { workflowsPath: workflowPath("inprocess.workflows") },
          history,
          workflowId,
        ),
      ).resolves.toBeUndefined();
    }
  });
});
