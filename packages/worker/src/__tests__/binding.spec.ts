import { randomUUID } from "node:crypto";

import { TypedClient } from "@temporal-contract/client";
import { defineContractBinding } from "@temporal-contract/contract";
import { it } from "@temporal-contract/testing/extension";
import { fixturePath } from "@temporal-contract/testing/workflow-bundle";
import { Client } from "@temporalio/client";
import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { declareActivitiesHandler } from "../activity.js";
import { TypedWorker } from "../worker.js";
import { bindingContract } from "./binding.contract.js";

describe("runtime contract bindings", () => {
  it("routes the same workflow type to two implementations in one namespace", async ({
    workerConnection,
    clientConnection,
  }) => {
    const first = defineContractBinding(bindingContract, {
      taskQueue: `binding-a-${randomUUID()}`,
    });
    const second = defineContractBinding(bindingContract, {
      taskQueue: `binding-b-${randomUUID()}`,
    });
    const workers: TypedWorker[] = [];
    const runs: Promise<unknown>[] = [];
    try {
      for (const [contract, marker] of [
        [first, "first"],
        [second, "second"],
      ] as const) {
        const worker = await TypedWorker.create({
          contract,
          connection: workerConnection,
          namespace: "default",
          workflowsPath: fixturePath(import.meta.url, "binding.workflows"),
          activities: declareActivitiesHandler({
            contract,
            activities: { run: { identify: () => OkAsync(marker) } },
          }),
        }).get();
        workers.push(worker);
        runs.push(worker.run().get());
      }
      const client = await TypedClient.create({
        client: new Client({ connection: clientConnection, namespace: "default" }),
      }).get();
      const results = await Promise.all([
        client
          .for(first)
          .executeWorkflow("run", { workflowId: `binding/${randomUUID()}`, args: {} })
          .getOrThrow(),
        client
          .for(second)
          .executeWorkflow("run", { workflowId: `binding/${randomUUID()}`, args: {} })
          .getOrThrow(),
      ]);
      expect(results).toEqual(["first", "second"]);
    } finally {
      for (const worker of workers) worker.shutdown();
      await Promise.all(runs);
    }
  });
});
