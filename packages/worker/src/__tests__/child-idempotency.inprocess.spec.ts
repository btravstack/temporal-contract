import { testRig } from "@temporal-contract/testing/test-rig";
import { it } from "@temporal-contract/testing/time-skipping";
import { bundleFor, fixturePath } from "@temporal-contract/testing/workflow-bundle";
import { describe, expect } from "vitest";

import { childIdempotencyContract } from "./child-idempotency.contract.js";

/**
 * Real-server (time-skipping) coverage of contract-declared idempotency at
 * the CHILD-WORKFLOW boundary — `context.startChildWorkflow` and
 * `context.executeChildWorkflow`, both of which now apply the contract's
 * declared `idempotency` mode as `workflowIdReusePolicy`
 * (`child-workflow.ts`).
 *
 * This replaces an earlier version of this coverage that lived in
 * `child-workflow.spec.ts` and mocked `@temporalio/workflow`'s
 * `startChild`/`executeChild` to assert the ARGS SHAPE they were called
 * with. That tripped the workspace's `no-sdk-mocks` guard
 * (`packages/testing/src/no-sdk-mocks.spec.ts`), whose allowlist "may only
 * ever shrink" — the default answer for an SDK mock is to move the test
 * here and assert the EFFECT instead, exactly as
 * `idempotency.inprocess.spec.ts` already does for the top-level client
 * paths and `child-wire.inprocess.spec.ts` does for the child-workflow wire
 * format. Moving here also upgrades the proof from "the right string was
 * passed" to "Temporal actually rejected the duplicate start" — closing the
 * gap between this file and the client-side effect proof.
 *
 * SHARED STATIC QUEUE CAVEAT (mirrors `continue-as-new.inprocess.spec.ts`
 * and `child-wire.inprocess.spec.ts`): `context.startChildWorkflow`/
 * `executeChildWorkflow` always route to whatever CONTRACT OBJECT the
 * workflow implementation passes at the call site — here, the plain
 * `childIdempotencyContract` statically imported by
 * `child-idempotency.workflows.ts`, never a per-test `withTaskQueue`-scoped
 * contract the test's own worker/client happen to use. Every test below
 * binds its worker/client to the unscoped `childIdempotencyContract`
 * instead, so the child always lands where this worker is actually polling.
 * Safe because Vitest runs this file's tests sequentially and
 * `worker.raw.runUntil` drains each worker before its test returns.
 *
 * Each `parent` execution starts (or executes) `onceChild` TWICE under the
 * SAME child workflow ID within a single parent run — see
 * `child-idempotency.workflows.ts`'s doc comment for why that's equivalent
 * to (and simpler than) two separate top-level starts for proving
 * `workflowIdReusePolicy`.
 */
const WORKFLOW_EXECUTION_TIMEOUT = "30 seconds";

describe("contract-declared idempotency — child-workflow boundary, real server", () => {
  it("startChildWorkflow: a second start under the same id is rejected after the first completes", async ({
    testEnv,
  }) => {
    const contract = childIdempotencyContract;
    const bundle = await bundleFor(fixturePath(import.meta.url, "child-idempotency.workflows"));
    const { worker, client } = await testRig(testEnv, { contract, bundle });

    const result = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("parent", {
          workflowId: "child-idempotency-start-once",
          args: { mode: "start", childWorkflowId: "child-idempotency-start-once-child" },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      return handle.result().getOrThrow();
    });

    // Baseline: the first attempt succeeds — proves the rejection below is a
    // dedup effect, not a fixture that can never start a child at all.
    expect(result.firstOk).toBe(true);
    // The crux: the SECOND start, under the same workflow ID, after the
    // first has already closed (Completed) — rejected. Temporal's OWN
    // default (`ALLOW_DUPLICATE`) would let this through, so a regression
    // that dropped the contract's `REJECT_DUPLICATE` anywhere between
    // `createStartChildWorkflow` and Temporal turns this `false` into `true`.
    expect(result.secondOk).toBe(false);
    // Identity, not just "an error happened": the rejection is specifically
    // Temporal's duplicate-workflow-ID failure.
    expect(result.secondRejectedAsAlreadyStarted).toBe(true);
  });

  it("executeChildWorkflow: a second start under the same id is rejected after the first completes", async ({
    testEnv,
  }) => {
    const contract = childIdempotencyContract;
    const bundle = await bundleFor(fixturePath(import.meta.url, "child-idempotency.workflows"));
    const { worker, client } = await testRig(testEnv, { contract, bundle });

    const result = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("parent", {
          workflowId: "child-idempotency-execute-once",
          args: { mode: "execute", childWorkflowId: "child-idempotency-execute-once-child" },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      return handle.result().getOrThrow();
    });

    expect(result.firstOk).toBe(true);
    expect(result.secondOk).toBe(false);
    expect(result.secondRejectedAsAlreadyStarted).toBe(true);
  });

  it("startChildWorkflow: an explicit per-call ALLOW_DUPLICATE overrides the contract's once-per-id", async ({
    testEnv,
  }) => {
    const contract = childIdempotencyContract;
    const bundle = await bundleFor(fixturePath(import.meta.url, "child-idempotency.workflows"));
    const { worker, client } = await testRig(testEnv, { contract, bundle });

    const result = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("parent", {
          workflowId: "child-idempotency-start-override",
          args: {
            mode: "start",
            childWorkflowId: "child-idempotency-start-override-child",
            overridePolicy: "ALLOW_DUPLICATE",
          },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      return handle.result().getOrThrow();
    });

    expect(result.firstOk).toBe(true);
    // Without the override this would be `false` (previous test) — the only
    // difference here is the explicit per-call `workflowIdReusePolicy` on
    // the second attempt, which must still win over the contract's
    // `once-per-id` default.
    expect(result.secondOk).toBe(true);
    expect(result.secondRejectedAsAlreadyStarted).toBe(false);
  });

  it("executeChildWorkflow: an explicit per-call ALLOW_DUPLICATE overrides the contract's once-per-id", async ({
    testEnv,
  }) => {
    const contract = childIdempotencyContract;
    const bundle = await bundleFor(fixturePath(import.meta.url, "child-idempotency.workflows"));
    const { worker, client } = await testRig(testEnv, { contract, bundle });

    const result = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("parent", {
          workflowId: "child-idempotency-execute-override",
          args: {
            mode: "execute",
            childWorkflowId: "child-idempotency-execute-override-child",
            overridePolicy: "ALLOW_DUPLICATE",
          },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      return handle.result().getOrThrow();
    });

    expect(result.firstOk).toBe(true);
    expect(result.secondOk).toBe(true);
    expect(result.secondRejectedAsAlreadyStarted).toBe(false);
  });
});
