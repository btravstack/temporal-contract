/**
 * The one-call time-skipping fixture, exercised against a real time-skipping
 * server.
 *
 * This suite IS the assertion: everything the sibling `*.inprocess.spec.ts`
 * files wire by hand — the environment, the workflow bundle, the worker, the
 * `TypedClient` + contract binding, and the replay-on-finish check — is
 * supplied by the single `createTimeSkippingContractTest(...)` call below. If
 * any of that wiring is wrong, these tests cannot run at all.
 */
import { createTimeSkippingContractTest } from "@temporal-contract/testing/time-skipping";
import { fixturePath } from "@temporal-contract/testing/workflow-bundle";
import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { declareActivitiesHandler } from "../activity.js";
import { inprocessContract } from "./inprocess.contract.js";

const activities = declareActivitiesHandler({
  contract: inprocessContract,
  activities: {
    placeOrder: {
      charge: () => OkAsync({ transactionId: "txn-one-call" }),
    },
  },
});

const it = createTimeSkippingContractTest({
  contract: inprocessContract,
  workflowsPath: fixturePath(import.meta.url, "inprocess.workflows"),
  activities,
});

describe("createTimeSkippingContractTest", () => {
  it("runs a workflow end to end with no Docker and no hand-wiring", async ({ worker, client }) => {
    const outcome = await worker.raw.runUntil(async () =>
      client.executeWorkflow("placeOrder", {
        workflowId: `one-call-${Date.now()}`,
        args: { orderId: "ORD-1", amount: 42 },
      }),
    );

    expect(outcome).toBeOk();
  });

  it("hands out a client bound to the contract, so unknown names don't compile", async ({
    client,
  }) => {
    // @ts-expect-error -- "notOnThisContract" is not a workflow of inprocessContract
    const bad = () => client.startWorkflow("notOnThisContract", { workflowId: "x", args: {} });
    void bad;

    expect(typeof client.executeWorkflow).toBe("function");
  });
});
