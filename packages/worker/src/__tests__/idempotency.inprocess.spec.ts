import {
  WORKFLOW_ALREADY_STARTED_ERROR_TAG,
  WORKFLOW_FAILED_ERROR_TAG,
} from "@temporal-contract/client";
import { testRig } from "@temporal-contract/testing/test-rig";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { describe, expect } from "vitest";

import { idempotencyContract } from "./idempotency.contract.js";

const WORKFLOW_EXECUTION_TIMEOUT = "30 seconds";

describe("contract-declared idempotency deduplicates on the real server", () => {
  // Task 2 proved the client CONSTRUCTS the right workflowIdReusePolicy.
  // That survives the option being dropped anywhere between the client and
  // Temporal — these tests instead start a workflow twice against a real
  // server and assert on the identity of what actually happened.

  it("once-per-id rejects a second start after a successful run", async ({ testEnv }) => {
    const contract = withTaskQueue(idempotencyContract, nextTaskQueueId("idempotency-once"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "idempotency.workflows"));
    const { worker, client } = await testRig(testEnv, { contract, bundle });
    const workflowId = "once-success";

    await worker.raw.runUntil(async () => {
      const first = await client.executeWorkflow("onceWorkflow", {
        workflowId,
        args: { shouldFail: false },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      });
      expect(first).toBeOkWith({ ok: true });

      const second = await client.executeWorkflow("onceWorkflow", {
        workflowId,
        args: { shouldFail: false },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      });

      // The whole point: identity of the rejection, not merely that it's an
      // Err. A regression that dropped REJECT_DUPLICATE anywhere between the
      // client and Temporal would let this second start through as Ok.
      expect(second).toBeErrTagged(WORKFLOW_ALREADY_STARTED_ERROR_TAG);
    });
  });

  it("retry-if-failed rejects a second start after a successful run", async ({ testEnv }) => {
    const contract = withTaskQueue(idempotencyContract, nextTaskQueueId("idempotency-retry-ok"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "idempotency.workflows"));
    const { worker, client } = await testRig(testEnv, { contract, bundle });
    const workflowId = "retry-success";

    await worker.raw.runUntil(async () => {
      const first = await client.executeWorkflow("retryWorkflow", {
        workflowId,
        args: { shouldFail: false },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      });
      expect(first).toBeOkWith({ ok: true });

      const second = await client.executeWorkflow("retryWorkflow", {
        workflowId,
        args: { shouldFail: false },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      });

      expect(second).toBeErrTagged(WORKFLOW_ALREADY_STARTED_ERROR_TAG);
    });
  });

  it("retry-if-failed allows a second start after a failed run", async ({ testEnv }) => {
    const contract = withTaskQueue(idempotencyContract, nextTaskQueueId("idempotency-retry-fail"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "idempotency.workflows"));
    const { worker, client } = await testRig(testEnv, { contract, bundle });
    const workflowId = "retry-failed-then-retried";

    await worker.raw.runUntil(async () => {
      const first = await client.executeWorkflow("retryWorkflow", {
        workflowId,
        args: { shouldFail: true },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      });
      expect(first).toBeErrTagged(WORKFLOW_FAILED_ERROR_TAG);

      // Together with the previous test, this is what actually
      // distinguishes retry-if-failed from once-per-id and allow-duplicate:
      // rejected after success, allowed after failure. Either test alone
      // would pass for the wrong reason (once-per-id would fail only this
      // one; allow-duplicate would pass both for a reason unrelated to the
      // prior run's outcome).
      const second = await client.executeWorkflow("retryWorkflow", {
        workflowId,
        args: { shouldFail: false },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      });
      expect(second).toBeOkWith({ ok: true });
    });
  });

  it("allow-duplicate allows a second start after a successful run", async ({ testEnv }) => {
    const contract = withTaskQueue(idempotencyContract, nextTaskQueueId("idempotency-allow"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "idempotency.workflows"));
    const { worker, client } = await testRig(testEnv, { contract, bundle });
    const workflowId = "allow-success";

    await worker.raw.runUntil(async () => {
      const first = await client.executeWorkflow("allowWorkflow", {
        workflowId,
        args: { shouldFail: false },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      });
      expect(first).toBeOkWith({ ok: true });

      const second = await client.executeWorkflow("allowWorkflow", {
        workflowId,
        args: { shouldFail: false },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      });
      expect(second).toBeOkWith({ ok: true });
    });
  });

  it("an explicit per-call ALLOW_DUPLICATE overrides a once-per-id contract", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(idempotencyContract, nextTaskQueueId("idempotency-override"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "idempotency.workflows"));
    const { worker, client } = await testRig(testEnv, { contract, bundle });
    const workflowId = "once-overridden";

    await worker.raw.runUntil(async () => {
      const first = await client.executeWorkflow("onceWorkflow", {
        workflowId,
        args: { shouldFail: false },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      });
      expect(first).toBeOkWith({ ok: true });

      const second = await client.executeWorkflow("onceWorkflow", {
        workflowId,
        args: { shouldFail: false },
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
      });
      expect(second).toBeOkWith({ ok: true });
    });
  });
});
