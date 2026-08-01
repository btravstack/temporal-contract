import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { TypedClient, WorkflowFailedError } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { ApplicationFailure } from "@temporalio/client";
import { describe, expect } from "vitest";

import { TypedWorker } from "../worker.js";
import { continueAsNewContract } from "./continue-as-new.contract.js";

/**
 * Real `context.continueAsNew(...)` coverage against a time-skipping
 * server — the mocked `makeContinueAsNewFunc` (the old `continue-as-new.spec.ts`)
 * could only assert that a stub was CALLED with a particular options shape;
 * it could never prove the NEXT run actually receives the carried state,
 * which is the whole point of continue-as-new. Losing state across a
 * continue-as-new boundary loses money.
 */
function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}

/**
 * Bounds every workflow started below. `createContinueAsNew` validates
 * before calling Temporal and throws a non-retryable `ApplicationFailure`
 * on failure — but a REGRESSION that broke that validation-before-send
 * guarantee, or the dispatch heuristic, or the "no smuggling" ordering,
 * could route a continuation to a task queue/workflow type nothing
 * services, or (for `invalidContinuation`, which continues unconditionally)
 * spin an unbounded continue-as-new chain. Without this bound such a
 * regression would hang to the project's 120s `integration-inprocess`
 * timeout; with it, the execution ends `TimedOut` well inside that window
 * (an idle wait on an unpolled queue is fast-forwarded by time-skipping
 * almost instantly — see the cancellation suite for the same technique).
 */
const WORKFLOW_EXECUTION_TIMEOUT = "30 seconds";

describe("continue-as-new against a real server", () => {
  it("carries accumulated state across two continue-as-new boundaries, and forwards continuation options to Temporal", async ({
    testEnv,
  }) => {
    // NOT `withTaskQueue`-scoped: the same-workflow branch of
    // `context.continueAsNew` derives its destination task queue from the
    // CONTRACT OBJECT `declareWorkflow` was bound to at module-load time
    // (`continueAsNewContract`, statically imported by the bundled workflow
    // module) — not from whatever contract the test's worker/client happen
    // to be scoped to. Only the module's own, real `taskQueue` lines up with
    // where the continuation actually lands.
    const contract = continueAsNewContract;
    const bundle = await bundleFor(workflowPath("continue-as-new.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const { total, memo } = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("accumulate", {
          workflowId: "continue-as-new-accumulate",
          args: { cursor: 3, total: 0 },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      const result = await handle.result().getOrThrow();
      const description = await handle.raw.describe();
      return { total: result.total, memo: description.memo };
    });

    // EFFECT 1: 3 + 2 + 1 — proving state really crossed TWO continue-as-new
    // boundaries, which a mocked `makeContinueAsNewFunc` could never show.
    expect(total).toBe(6);

    // EFFECT 2 (options forwarding): the `memo` passed alongside the FINAL
    // continuation genuinely reached Temporal — not merely spread into a
    // captured call-shape object, but visible on the actual execution.
    expect(memo).toEqual({ hop: "1" });
  });

  it("the validated target wins: a smuggled workflowType/taskQueue override cannot redirect a continuation", async ({
    testEnv,
  }) => {
    // Same reason as the test above: same-workflow continuation targets the
    // MODULE's own `continueAsNewContract.taskQueue`, so the worker/client
    // must be bound to the unscoped contract, not a per-test queue.
    const contract = continueAsNewContract;
    const bundle = await bundleFor(workflowPath("continue-as-new.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const total = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("accumulate", {
          workflowId: "continue-as-new-smuggle",
          args: { cursor: 3, total: 0, smuggle: true },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      const result = await handle.result().getOrThrow();
      return result.total;
    });

    // EFFECT: despite every continuation smuggling
    // `workflowType: "evil"` / `taskQueue: "evil-queue"` into the options
    // bag, the validated target (accumulate, on THIS worker's real task
    // queue) won — the run still reaches 6. If the smuggle ever succeeded,
    // the continuation would land on a queue no worker polls and this
    // execution would end `TimedOut` (bounded above) instead of completing
    // with `total: 6`.
    expect(total).toBe(6);
  });

  it("rejects a same-workflow continuation whose args fail its own input schema", async ({
    testEnv,
  }) => {
    const contract = continueAsNewContract;
    const bundle = await bundleFor(workflowPath("continue-as-new.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const result = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("invalidContinuation", {
          workflowId: "continue-as-new-invalid",
          args: { n: 1 },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      return handle.result();
    });

    // EFFECT: the execution fails terminally, on its very first Workflow
    // Task, with the SAME typed validation failure `declareWorkflow`'s own
    // incoming-input validation would raise — not a hang (an unbounded
    // Workflow Task retry loop) and not a generic/unrelated error.
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error).toBeInstanceOf(WorkflowFailedError);
    const cause = (result.error as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect((cause as ApplicationFailure).type).toBe("WorkflowInputValidationError");
    expect((cause as ApplicationFailure).message).toBe(
      'Workflow "invalidContinuation" input validation failed: at n: Invalid input',
    );
  });

  it("sends the original args across a continuation, not the schema-parsed value", async ({
    testEnv,
  }) => {
    const contract = continueAsNewContract;
    const bundle = await bundleFor(workflowPath("continue-as-new.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const result = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("transformOnce", {
          workflowId: "continue-as-new-transform-once",
          args: { text: "irrelevant-first-run", hops: 0 },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      return handle.result().getOrThrow();
    });

    // EFFECT: exactly ONE "!" — the receiving run's OWN parse. If
    // `createContinueAsNew` sent the schema-PARSED value instead of the
    // original ("seed", "hops": 1) args, the wire would already carry
    // "seed!" and the receiving run's own parse would add a SECOND bang
    // ("seed!!").
    expect(result.text).toBe("seed!");
  });

  it("cross-contract continuation lands on the destination workflow type and task queue", async ({
    testEnv,
  }) => {
    const queueId = nextTaskQueueId("continue-as-new");
    const contract = withTaskQueue(continueAsNewContract, queueId);
    const bundle = await bundleFor(workflowPath("continue-as-new.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const raw = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("crossContractDispatcher", {
          workflowId: "continue-as-new-cross-valid",
          args: { mode: "valid", otherTaskQueue: queueId },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      // `handle.raw.result()`, not the typed client's `.result()`: the
      // typed client would re-validate the final payload against
      // `crossContractDispatcher`'s OWN output schema (`{}`), silently
      // stripping `archive`'s actual `{ batchId }` output. `raw` shows the
      // literal value the destination workflow — on a DIFFERENT contract —
      // actually returned.
      return handle.raw.result();
    });

    // EFFECT: the execution actually completed AS `archive`, with its own
    // output — not merely "didn't error", which a misrouted or stuck
    // continuation could also (differently) satisfy.
    expect(raw).toEqual({ batchId: "B-1" });
  });

  it("rejects a cross-contract continuation whose args fail the destination's input schema", async ({
    testEnv,
  }) => {
    const queueId = nextTaskQueueId("continue-as-new");
    const contract = withTaskQueue(continueAsNewContract, queueId);
    const bundle = await bundleFor(workflowPath("continue-as-new.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const result = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("crossContractDispatcher", {
          workflowId: "continue-as-new-cross-invalid-args",
          args: { mode: "invalidArgs", otherTaskQueue: queueId },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      return handle.result();
    });

    // EFFECT: validated against the DESTINATION's ("archive") schema, not
    // the caller's own — the message names "archive", not
    // "crossContractDispatcher".
    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error).toBeInstanceOf(WorkflowFailedError);
    const cause = (result.error as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect((cause as ApplicationFailure).type).toBe("WorkflowInputValidationError");
    expect((cause as ApplicationFailure).message).toBe(
      'Workflow "archive" input validation failed: at batchId: Invalid input',
    );
  });

  it("rejects a cross-contract continuation naming an undeclared target workflow", async ({
    testEnv,
  }) => {
    const queueId = nextTaskQueueId("continue-as-new");
    const contract = withTaskQueue(continueAsNewContract, queueId);
    const bundle = await bundleFor(workflowPath("continue-as-new.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const result = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("crossContractDispatcher", {
          workflowId: "continue-as-new-cross-undeclared",
          args: { mode: "undeclaredTarget", otherTaskQueue: queueId },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      return handle.result();
    });

    expect(result.isErr()).toBe(true);
    if (!result.isErr()) return;
    expect(result.error).toBeInstanceOf(WorkflowFailedError);
    const cause = (result.error as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect((cause as ApplicationFailure).type).toBe("WorkflowInputValidationError");
    expect((cause as ApplicationFailure).message).toBe(
      'Workflow "ghost" input validation failed: continueAsNew target workflow "ghost" is not declared on the supplied contract.',
    );
  });

  it("a same-workflow continuation isn't misrouted when its args merely look contract-shaped (no second positional arg)", async ({
    testEnv,
  }) => {
    const contract = continueAsNewContract;
    const bundle = await bundleFor(workflowPath("continue-as-new.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const result = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("dispatchHeuristic", {
          workflowId: "continue-as-new-heuristic-treacherous",
          args: { hop: 0, mode: "treacherous-shape", taskQueue: "hostile-queue", workflows: {} },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      return handle.result().getOrThrow();
    });

    // EFFECT: the single-arg continuation stayed same-workflow and ran to
    // completion — a misrouted (cross-contract) dispatch would instead fail
    // the execution (the treacherous `workflows` object has no matching
    // workflow definition to validate against).
    expect(result.status).toBe("completed-same-workflow");
  });

  it("a same-workflow continuation isn't misrouted when args.workflows is null, even with a stray second positional arg", async ({
    testEnv,
  }) => {
    const contract = continueAsNewContract;
    const bundle = await bundleFor(workflowPath("continue-as-new.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const result = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("dispatchHeuristic", {
          workflowId: "continue-as-new-heuristic-null-workflows",
          args: { hop: 0, mode: "null-workflows", taskQueue: "hostile-queue", workflows: null },
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();

      return handle.result().getOrThrow();
    });

    expect(result.status).toBe("completed-same-workflow");
  });
});
