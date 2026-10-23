import { randomUUID } from "node:crypto";

import { TypedClient, type ContractClient } from "@temporal-contract/client";
import { defineContractBinding } from "@temporal-contract/contract";
import { it as baseIt } from "@temporal-contract/testing/extension";
import { bundleFor, fixturePath } from "@temporal-contract/testing/workflow-bundle";
import { Client } from "@temporalio/client";
import { OkAsync } from "unthrown";
import { beforeAll, describe, expect, vi } from "vitest";

import { declareActivitiesHandler } from "../activity.js";
import { TypedWorker } from "../worker.js";
import { bindingContract } from "./binding.contract.js";

type BoundContract = ReturnType<typeof defineContractBinding<typeof bindingContract, string>>;

const it = baseIt.extend<{
  clients: readonly [
    Pick<ContractClient<BoundContract>, "executeWorkflow">,
    Pick<ContractClient<BoundContract>, "executeWorkflow">,
  ];
}>({
  clients: async ({ workerConnection, clientConnection }, use) => {
    const first = defineContractBinding(bindingContract, {
      taskQueue: `binding-a-${randomUUID()}`,
    });
    const second = defineContractBinding(bindingContract, {
      taskQueue: `binding-b-${randomUUID()}`,
    });
    const workflowBundle = await bundleFor(fixturePath(import.meta.url, "binding.workflows"));
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
          workflowBundle,
          activities: declareActivitiesHandler({
            contract,
            activities: { run: { identify: () => OkAsync(marker) } },
          }),
        }).get();
        workers.push(worker);
        runs.push(worker.run().get());
        await vi.waitUntil(() => worker.raw.getState() === "RUNNING");
      }
      const client = await TypedClient.create({
        client: new Client({ connection: clientConnection, namespace: "default" }),
      }).get();
      await use([client.for(first), client.for(second)]);
    } finally {
      for (const worker of workers) worker.shutdown().get();
      await Promise.all(runs);
    }
  },
});

describe("runtime contract bindings", () => {
  beforeAll(async () => {
    await bundleFor(fixturePath(import.meta.url, "binding.workflows"));
  });

  it("routes the same workflow type to two implementations in one namespace", async ({
    clients,
  }) => {
    const results = await Promise.all(
      clients.map((client) =>
        client
          .executeWorkflow("run", { workflowId: `binding/${randomUUID()}`, args: {} })
          .getOrThrow(),
      ),
    );
    expect(results).toEqual(["first", "second"]);
  });
});
