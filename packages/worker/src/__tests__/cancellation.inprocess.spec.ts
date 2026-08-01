import {
  TypedClient,
  WORKFLOW_CANCELLED_ERROR_TAG,
  WorkflowCancelledError,
} from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { Context } from "@temporalio/activity";
import { CancelledFailure } from "@temporalio/common";
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
/**
 * Bounds every workflow started below. A regression in the `context`
 * wiring that mounts `cancellableScope`/`nonCancellableScope` (e.g. a
 * missing property) throws a `TypeError` INSIDE the workflow, which
 * Temporal reports as a Workflow Task failure and retries indefinitely —
 * that is not a hang this suite can catch with an assertion alone. Without
 * this bound, such a regression would hang every test below to the
 * project's 120s `integration-inprocess` timeout; with it, the execution
 * ends `TimedOut` (surfaced as `Err(WorkflowTimeoutError)`, distinct from
 * every value this file's assertions actually expect) well inside that
 * window. 30s comfortably exceeds the longest legitimate real-time wait in
 * this file (the ~2s `nonCancellableWorkflow` activity sleep, or the
 * hazard/fix tests' up-to-5s sleep cut short by heartbeat-detected
 * cancellation) while still failing far faster than the outer test timeout.
 */
const WORKFLOW_EXECUTION_TIMEOUT = "30 seconds";

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
    const bundle = await bundleFor(fixturePath(import.meta.url, "inprocess.workflows"));

    const worker = await TypedWorker.create({
      contract,
      connection: testEnv.nativeConnection,
      workflowBundle: bundle,
    }).get();

    const typedClient = await TypedClient.create({ client: testEnv.client }).get();
    const client = typedClient.for(contract);

    const outcome = await worker.raw.runUntil(async () => {
      const handle = await client
        .startWorkflow("waitForever", {
          workflowId: "cancellation-blocked-scope",
          args: {},
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow();
      await handle.cancel().getOrThrow();
      return handle.result();
    });

    // EFFECT: the execution ended Cancelled — the client's first-class
    // WorkflowCancelledError, not a blanket "some Err happened" (which a
    // timeout, a terminate, or a business failure would also satisfy).
    expect(outcome).toBeErrTagged(WORKFLOW_CANCELLED_ERROR_TAG);

    // EFFECT (cause preservation): the ORIGINAL CancelledFailure Temporal
    // raised is still reachable on `.cause` — not dropped in the fold from
    // the SDK's `WorkflowFailedError` into this package's typed
    // `WorkflowCancelledError`. Structural (`instanceof`), not an exact
    // message string: unlike the manufactured-cancellation tests below, this
    // cancellation is genuinely issued by the real server, whose internal
    // CancelledFailure message text is not this test's to dictate.
    if (!outcome.isErr()) return;
    expect(outcome.error).toBeInstanceOf(WorkflowCancelledError);
    if (!(outcome.error instanceof WorkflowCancelledError)) return;
    expect(outcome.error.cause).toBeInstanceOf(CancelledFailure);
  });

  it("proves the swallowed-cancellation hazard: a generic Err-to-fallback handler absorbs a cancelled activity call and completes normally", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(cancellationContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "cancellation.workflows"));

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
        .startWorkflow("swallowsCancellation", {
          workflowId: "cancellation-swallow",
          args: {},
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
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
    const bundle = await bundleFor(fixturePath(import.meta.url, "cancellation.workflows"));

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
        .startWorkflow("honorsCancellation", {
          workflowId: "cancellation-honor",
          args: {},
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
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
    const bundle = await bundleFor(fixturePath(import.meta.url, "cancellation.workflows"));

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
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
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
    const bundle = await bundleFor(fixturePath(import.meta.url, "cancellation.workflows"));

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
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      }),
    );

    expect(outcome).toBeOkWith({ outcome: "ok:resolved" });
  });

  it("cancellableScope routes a non-cancellation throw to the defect channel, not Err", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(cancellationContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "cancellation.workflows"));

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
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      }),
    );

    // EFFECT: specifically "defect:<the original cause's own message>" — not
    // "err" (which the hazard tests above prove IS what a cancellation
    // produces), proving both that the two channels are genuinely
    // distinguished AND that the original cause (`result.cause` inside
    // `cancellableScope`) survives intact rather than being dropped or
    // replaced en route to the defect channel.
    expect(outcome).toBeOkWith({ outcome: "defect:cancellable-scope-bug" });
  });

  it("nonCancellableScope resolves a synchronous (non-Promise) callback to Ok", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(cancellationContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "cancellation.workflows"));

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
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      }),
    );

    expect(outcome).toBeOkWith({ outcome: "ok:42" });
  });

  it("nonCancellableScope routes a non-cancellation throw to the defect channel, not Err", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(cancellationContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "cancellation.workflows"));

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
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      }),
    );

    // EFFECT: exact cause message, mirroring the `cancellableScope` variant
    // above — proves `nonCancellableScope`'s catch block preserves the
    // original cause too, not just its own equivalent classification.
    expect(outcome).toBeOkWith({ outcome: "defect:non-cancellable-scope-bug" });
  });

  it("nonCancellableScope still folds an internally-raised (real) CancelledFailure into Err(WorkflowCancelledError)", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(cancellationContract, nextTaskQueueId("cancellation"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "cancellation.workflows"));

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
        workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
      }),
    );

    // EFFECT: a genuinely cancellation-shaped internal failure (a real
    // `CancelledFailure`, not a mocked `isCancellation`) is still folded
    // into the typed Err — distinct from the "any other throw is a defect"
    // case proven above — AND the exact cause message ("manufactured
    // internal cancel", the literal string this test threw) survives onto
    // `WorkflowCancelledError.cause`, proving cause preservation on the Err
    // path too, not just the defect path.
    expect(outcome).toBeOkWith({
      outcome: "err:WorkflowCancelledError:manufactured internal cancel",
    });
  });
});
