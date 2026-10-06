/**
 * Integration coverage for `createContractTest` against the
 * testcontainers-provided Temporal server (started by this package's own
 * `global-setup`): the fixtures wire a running worker, the connection-scoped
 * root, and the contract-bound client, and a workflow executes end-to-end
 * through them.
 */
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { declareActivitiesHandler } from "@temporal-contract/worker/activity";
import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { createContractTest } from "../contract.js";
import { testContract } from "./test.contract.js";
// The worker loads this module by path (`workflowsPath`); importing it here
// too keeps its exports type-checked and visible to static analysis.
import * as workflows from "./test.workflows.js";

// One function reference for both scopes: `decorate` is one activity.
const decorate = ({ input: { name } }: { input: { name: string } }) =>
  OkAsync({ decorated: name.toUpperCase() });

const activities = declareActivitiesHandler({
  contract: testContract,
  activities: { greet: { decorate }, greetDerived: { decorate } },
});

const it = createContractTest({
  contract: testContract,
  workflowsPath: fileURLToPath(
    new URL(`./test.workflows${extname(import.meta.url)}`, import.meta.url),
  ),
  activities,
});

describe("createContractTest", () => {
  it("executes a workflow end-to-end through the contract-bound client", async ({ client }) => {
    const result = await client.executeWorkflow("greet", {
      workflowId: `greet-${Date.now()}`,
      args: { name: "world" },
    });

    expect(result).toBeOkWith({ message: "Hello, WORLD!" });
  });

  it("exposes the running worker and the connection-scoped root", async ({
    worker,
    typedClient,
    client,
  }) => {
    expect(worker.raw.getState()).toBe("RUNNING");
    // The root memoizes contract bindings — the fixture's client is the
    // same instance `for()` hands out.
    expect(typedClient.for(testContract)).toBe(client);
    // Sanity: the module registered via `workflowsPath` exports the
    // workflow the contract declares.
    expect(workflows.greet).toBeTypeOf("function");
    expect(workflows.greetDerived).toBeTypeOf("function");
  });

  it("runs the worker and the client in a namespace of its own", ({
    namespace,
    typedClient,
    worker,
  }) => {
    // Parallel test files share one server and the contract's task queue;
    // only a per-file namespace keeps their workers apart.
    expect(namespace).toMatch(/^contract-test-/);
    expect(typedClient.raw.options.namespace).toBe(namespace);
    expect(worker.raw.options.namespace).toBe(namespace);
  });

  it("starts a workflow and reads its result through a typed handle", async ({ client }) => {
    const workflowId = `greet-handle-${Date.now()}`;
    const handleResult = await client.startWorkflow("greet", {
      workflowId,
      args: { name: "fixtures" },
    });

    expect(handleResult).toBeOk();
    if (!handleResult.isOk()) return;

    expect(handleResult.value.workflowId).toBe(workflowId);
    const result = await handleResult.value.result();
    expect(result).toBeOkWith({ message: "Hello, FIXTURES!" });
  });
});
