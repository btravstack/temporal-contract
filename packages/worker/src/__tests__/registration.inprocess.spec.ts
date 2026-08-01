import { TypedClient } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { describe, expect } from "vitest";

import { TechnicalError, TypedWorker } from "../worker.js";
import { registrationContract } from "./registration.contract.js";

/**
 * Real-server coverage for `TypedWorker.create`'s workflow-registration
 * completeness check — see `verifyWorkflowRegistration`'s JSDoc on
 * `CreateWorkerOptions` in `../worker.ts`. The mocked `../worker.spec.ts`
 * this replaces faked `Worker.create` and asserted the exact call shape it
 * was invoked with; every test here instead proves an EFFECT against a real
 * time-skipping server — either the worker genuinely runs the registered
 * workflows, or creation fails with the registration diagnostic.
 *
 * CRITICAL CONSTRAINT: the check only runs when `workflowsPath` is supplied
 * — a prebuilt `workflowBundle` (the `bundleFor` helper used by every other
 * `*.inprocess.spec.ts` file) always skips it (see the option's JSDoc:
 * "Best-effort semantics: the check only runs when `workflowsPath` is
 * provided (prebuilt `workflowBundle`s are skipped)"). Using `bundleFor`
 * here would silently skip the very thing under test and every test below
 * would vacuously pass regardless of whether the check still works — so
 * every test passes a real `workflowsPath` fixture instead.
 */

/**
 * Bounds every workflow started below — see `continue-as-new.inprocess.spec.ts`'s
 * identical constant for the measured real-time rationale. A regression that
 * broke registration in a way that left the worker created but non-functional
 * would otherwise hang the test to the 120s `integration-inprocess` timeout
 * instead of failing an assertion.
 */
const WORKFLOW_EXECUTION_TIMEOUT = "30 seconds";

describe("workflow-registration completeness check — real server", () => {
  it("passes and actually runs every contract workflow when each is exported under its declared name", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(registrationContract, nextTaskQueueId("registration"));
    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowsPath: fixturePath(import.meta.url, "registration-complete.workflows"),
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    await worker.raw.runUntil(async () => {
      // EFFECT: both contract workflows actually execute through THIS
      // worker — not merely "creation returned Ok". A regression that
      // registered `alpha`/`beta` under the wrong Temporal workflow type
      // would leave these unpolled and time out instead of completing.
      const alpha = await client.executeWorkflow("alpha", {
        workflowId: "registration-complete-alpha",
        args: { value: "hi" },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      });
      expect(alpha).toBeOkWith({ result: "hi" });

      const beta = await client.executeWorkflow("beta", {
        workflowId: "registration-complete-beta",
        args: { n: 21 },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      });
      expect(beta).toBeOkWith({ doubled: 42 });
    });
  });

  it("accepts a raw workflow function exported under the contract name and runs it end to end", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(registrationContract, nextTaskQueueId("registration"));
    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowsPath: fixturePath(import.meta.url, "registration-raw.workflows"),
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    await worker.raw.runUntil(async () => {
      const alpha = await client.executeWorkflow("alpha", {
        workflowId: "registration-raw-alpha",
        args: { value: "raw" },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      });
      expect(alpha).toBeOkWith({ result: "raw" });

      // EFFECT: `beta` here is a plain function, not a `declareWorkflow`
      // export (no brand for the check to find) — it still registers and
      // runs correctly because Temporal dispatches by EXPORT name, which is
      // exactly the "raw workflow function" pattern the check must accept
      // rather than flag as missing.
      const beta = await client.executeWorkflow("beta", {
        workflowId: "registration-raw-beta",
        args: { n: 10 },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      });
      expect(beta).toBeOkWith({ doubled: 20 });
    });
  });

  it("errors (TechnicalError defect) when a contract workflow has no declareWorkflow export, naming it", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(registrationContract, nextTaskQueueId("registration"));
    const workerResult = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowsPath: fixturePath(import.meta.url, "registration-missing.workflows"),
    });

    expect(workerResult).toBeDefect();
    if (workerResult.isDefect()) {
      const cause = workerResult.cause;
      expect(cause).toBeInstanceOf(TechnicalError);
      const message = (cause as TechnicalError).message;
      expect(message).toContain("Workflow registration check failed");
      expect(message).toContain("no workflow export");
      expect(message).toContain("beta");
      expect(message).toContain("verifyWorkflowRegistration: false");
    }
  });

  it("errors when a declared workflow is exported under a different name (registration-name mismatch)", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(registrationContract, nextTaskQueueId("registration"));
    const workerResult = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowsPath: fixturePath(import.meta.url, "registration-mismatch.workflows"),
    });

    expect(workerResult).toBeDefect();
    if (workerResult.isDefect()) {
      const message = (workerResult.cause as TechnicalError).message;
      expect(message).toContain("export-name mismatch");
      expect(message).toContain('"alpha" is exported as "renamedAlpha"');
      expect(message).toContain("registers workflows by export name");
    }
  });

  it("verifyWorkflowRegistration: false opts out — an incomplete module creates the worker anyway, and the exported workflow still runs", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(registrationContract, nextTaskQueueId("registration"));
    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowsPath: fixturePath(import.meta.url, "registration-missing.workflows"),
      verifyWorkflowRegistration: false,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    await worker.raw.runUntil(async () => {
      // `beta` is missing from this fixture — the whole point of the
      // opt-out — so it is deliberately never invoked here (that would
      // hang: Temporal would never dispatch a task for an unregistered
      // workflow type). `alpha` IS exported and must still work, proving
      // the worker was genuinely created and functions — not merely `Ok` in
      // name while secretly broken.
      const alpha = await client.executeWorkflow("alpha", {
        workflowId: "registration-optout-alpha",
        args: { value: "optout" },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      });
      expect(alpha).toBeOkWith({ result: "optout" });
    });
  });
});
