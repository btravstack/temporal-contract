import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { TypedClient, WORKFLOW_CANCELLED_ERROR_TAG } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { Context } from "@temporalio/activity";
import { fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { ACTIVITY_CANCELLED_ERROR_TAG, declareActivitiesHandler } from "../activity.js";
import { TypedWorker } from "../worker.js";
import { cancellationContract } from "./cancellation.contract.js";
import { inprocessContract } from "./inprocess.contract.js";

/**
 * Real `CancellationScope` / cancellation-propagation coverage against a
 * time-skipping server — the mocked `CancellationScope`/`isCancellation`
 * (the old `cancellation.spec.ts`) could only assert that
 * `cancellableScope`/`nonCancellableScope` CALLED the mocked primitives; it
 * could never reproduce Temporal's actual cancellation propagation, nor the
 * swallowed-cancellation hazard this file exists to prove: an activity that
 * declares an `errors` map turns a cancellation into an `Err(...)` on the
 * SAME modeled channel as an ordinary declared failure, so a generic
 * "map every Err to a fallback" handler absorbs it — the workflow completes
 * `Completed` instead of `Cancelled`, silently overriding the cancel
 * request.
 */
function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}

/**
 * A real (wall-clock), cancellation-aware activity implementation for
 * `cancellationContract`'s `slowActivity`.
 *
 * Heartbeating is required for `Context.current().cancelled` to ever
 * reject: Temporal only delivers a cancellation notification to an
 * activity in the response of a heartbeat RPC. Racing the sleep against
 * `context.cancelled` is what lets the *swallow* and *honor* workflows
 * below actually observe an in-flight cancellation as
 * `Err(ActivityCancelledError)`, instead of the call quietly running to
 * completion in the background (Temporal's default
 * `ActivityCancellationType.WAIT_CANCELLATION_COMPLETED` would otherwise
 * leave the workflow-side await pending until the activity naturally
 * finishes).
 */
function cancellableSleep({ sleepMs }: { sleepMs: number }) {
  const context = Context.current();
  const work = (async () => {
    const heartbeat = setInterval(() => context.heartbeat(), 100);
    try {
      await Promise.race([
        new Promise<void>((resolve) => setTimeout(resolve, sleepMs)),
        context.cancelled,
      ]);
      return { done: true };
    } finally {
      clearInterval(heartbeat);
    }
  })();
  // `fromSafePromise` folds ANY rejection (not just the ones this activity
  // anticipates) into unthrown's `defect` channel — exactly what a
  // `CancelledFailure` rejection from `context.cancelled` needs: `activity.ts`
  // re-throws a defect's original cause unwrapped, so Temporal receives the
  // real `CancelledFailure` and reports the activity task as cancelled.
  return fromSafePromise(work);
}

describe("cancellation against a real server", () => {
  it("ends the execution Cancelled when a blocked scope is cancelled", async ({ testEnv }) => {
    const contract = withTaskQueue(inprocessContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(workflowPath("inprocess.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const outcome = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("waitForever", { workflowId: "cancellation-blocked-scope", args: {} })
        .getOrThrow();
      await handle.cancel().getOrThrow();
      return handle.result();
    });

    // EFFECT: the execution ended Cancelled — the client's first-class
    // WorkflowCancelledError, not a blanket "some Err happened" (which a
    // timeout, a terminate, or a business failure would also satisfy).
    expect(outcome).toBeErrTagged(WORKFLOW_CANCELLED_ERROR_TAG);
  });

  it("proves the swallowed-cancellation hazard: a generic Err-to-fallback handler absorbs a cancelled activity call and completes normally", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(cancellationContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(workflowPath("cancellation.workflows"));

    const activities = declareActivitiesHandler({
      contract,
      activities: { slowActivity: cancellableSleep },
    });

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
      activities,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const outcome = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("swallowsCancellation", { workflowId: "cancellation-swallow", args: {} })
        .getOrThrow();
      await handle.cancel().getOrThrow();
      return handle.result();
    });

    // EFFECT (the hazard): despite the cancel request, the execution
    // completed NORMALLY, carrying the specific tag that proves the
    // absorbed error really was the cancellation (not e.g. a validation
    // failure that would also satisfy a weaker "isOk()" assertion).
    expect(outcome).toBeOkWith({ status: `handled:${ACTIVITY_CANCELLED_ERROR_TAG}` });
  });

  it("proves the fix: rethrowCancellation re-raises the absorbed Err and ends the execution Cancelled", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(cancellationContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(workflowPath("cancellation.workflows"));

    const activities = declareActivitiesHandler({
      contract,
      activities: { slowActivity: cancellableSleep },
    });

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
      activities,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const outcome = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("honorsCancellation", { workflowId: "cancellation-honor", args: {} })
        .getOrThrow();
      await handle.cancel().getOrThrow();
      return handle.result();
    });

    // EFFECT: the same absorbed-Err situation as the hazard test above, but
    // this workflow recognizes ActivityCancelledError and re-raises it —
    // the execution ends Cancelled instead of Completed.
    expect(outcome).toBeErrTagged(WORKFLOW_CANCELLED_ERROR_TAG);
  });

  it("runs a nonCancellable scope to completion despite an outer cancel", async ({ testEnv }) => {
    const contract = withTaskQueue(cancellationContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(workflowPath("cancellation.workflows"));

    const activities = declareActivitiesHandler({
      contract,
      activities: { slowActivity: cancellableSleep },
    });

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
      activities,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const outcome = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("nonCancellableWorkflow", {
          workflowId: "cancellation-non-cancellable",
          args: {},
        })
        .getOrThrow();
      await handle.cancel().getOrThrow();
      return handle.result();
    });

    // EFFECT: the execution completed NORMALLY (specifically "completed",
    // not the activity-error fallback), proving the outer cancel request
    // never reached the activity call wrapped in nonCancellableScope.
    expect(outcome).toBeOkWith({ status: "completed" });
  });
});

/**
 * `cancellableScope`/`nonCancellableScope`'s own Result-folding mechanics —
 * success, an unmodeled (non-cancellation) throw routing to the `defect`
 * channel, and an internally-raised REAL `CancelledFailure` still folding
 * into `Err(WorkflowCancelledError)`. No activity, no real time: each mode
 * resolves within a single Workflow Task.
 */
describe("cancellableScope / nonCancellableScope mechanics against a real server", () => {
  it("cancellableScope resolves a synchronous (non-Promise) callback to Ok", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(cancellationContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(workflowPath("cancellation.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const outcome = await worker.raw.runUntil(async () =>
      client.executeWorkflow("scopeMechanics", {
        workflowId: "cancellation-scope-cancellable-ok",
        args: { mode: "cancellable-ok" },
      }),
    );

    expect(outcome).toBeOkWith({ outcome: "ok:resolved" });
  });

  it("cancellableScope routes a non-cancellation throw to the defect channel, not Err", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(cancellationContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(workflowPath("cancellation.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const outcome = await worker.raw.runUntil(async () =>
      client.executeWorkflow("scopeMechanics", {
        workflowId: "cancellation-scope-cancellable-defect",
        args: { mode: "cancellable-defect" },
      }),
    );

    // EFFECT: specifically "defect" — not "err" (which the hazard tests
    // above prove IS what a cancellation produces), proving the two
    // channels are genuinely distinguished rather than both landing on Err.
    expect(outcome).toBeOkWith({ outcome: "defect" });
  });

  it("nonCancellableScope resolves a synchronous (non-Promise) callback to Ok", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(cancellationContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(workflowPath("cancellation.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const outcome = await worker.raw.runUntil(async () =>
      client.executeWorkflow("scopeMechanics", {
        workflowId: "cancellation-scope-noncancellable-ok",
        args: { mode: "noncancellable-ok" },
      }),
    );

    expect(outcome).toBeOkWith({ outcome: "ok:42" });
  });

  it("nonCancellableScope routes a non-cancellation throw to the defect channel, not Err", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(cancellationContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(workflowPath("cancellation.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const outcome = await worker.raw.runUntil(async () =>
      client.executeWorkflow("scopeMechanics", {
        workflowId: "cancellation-scope-noncancellable-defect",
        args: { mode: "noncancellable-defect" },
      }),
    );

    expect(outcome).toBeOkWith({ outcome: "defect" });
  });

  it("nonCancellableScope still folds an internally-raised (real) CancelledFailure into Err(WorkflowCancelledError)", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(cancellationContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(workflowPath("cancellation.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const outcome = await worker.raw.runUntil(async () =>
      client.executeWorkflow("scopeMechanics", {
        workflowId: "cancellation-scope-noncancellable-internal-cancel",
        args: { mode: "noncancellable-internal-cancel" },
      }),
    );

    // EFFECT: a genuinely cancellation-shaped internal failure (a real
    // `CancelledFailure`, not a mocked `isCancellation`) is still folded
    // into the typed Err — distinct from the "any other throw is a defect"
    // case proven above.
    expect(outcome).toBeOkWith({ outcome: "err:WorkflowCancelledError" });
  });
});
