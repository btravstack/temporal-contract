import { ContractError, TypedClient, type ClientInterceptor } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import { fixturePath } from "@temporal-contract/testing/workflow-bundle";
import { OkAsync, ErrAsync } from "unthrown";
/**
 * Full contract-pipeline coverage against the time-skipping
 * `TestWorkflowEnvironment` (`@temporal-contract/testing/time-skipping`) —
 * no Docker required. Exercises, in-process:
 *
 * - `TypedWorker.create` / `TypedClient.create` AsyncResult factories,
 * - the activity-boundary wire format (sender validates and transmits the
 *   original value; receiver parses),
 * - `createContext` seed + accumulating middleware context,
 * - typed contract errors (activity-side rehydration in the workflow,
 *   workflow-side rehydration at the client),
 * - client interceptors observing every operation,
 * - contract-level `activityOptions` standing in for `activityOptions`,
 * - time skipping (an hour-long `sleep` resolving immediately).
 */
import { describe, expect } from "vitest";

import {
  composeActivityMiddleware,
  declareActivitiesHandler,
  declareActivityMiddleware,
} from "../activity.js";
import { TypedWorker, TechnicalError } from "../worker.js";
import { inprocessContract } from "./inprocess.contract.js";

const seenContexts: Record<string, unknown>[] = [];

const tracing = composeActivityMiddleware(
  declareActivityMiddleware<{ gateway: string }, { gateway: string; traceId: string }>(
    (invocation, next) => next({ context: { ...invocation.context, traceId: "trace-1" } }),
  ),
);

const activities = declareActivitiesHandler({
  contract: inprocessContract,
  createContext: () => ({ gateway: "test-gateway" }),
  middleware: tracing,
  activities: {
    placeOrder: {
      charge: ({ amount }, { errors, context }) => {
        seenContexts.push(context);
        if (amount < 0) {
          return ErrAsync(errors.PaymentDeclined({ reason: "negative-amount" }));
        }
        return OkAsync({ transactionId: `tx-${amount}-${context.traceId}` });
      },
    },
  },
});

const interceptedOperations: string[] = [];
const recording: ClientInterceptor = (args, next) => {
  interceptedOperations.push(args.operation);
  return next();
};

/** `EVENT_TYPE_WORKFLOW_TASK_COMPLETED` from `@temporalio/proto`'s `EventType` enum. */
const WORKFLOW_TASK_COMPLETED_EVENT_TYPE = 7;

describe("time-skipping TestWorkflowEnvironment", () => {
  it("runs the full contract pipeline in-process", async ({ testEnv }) => {
    const workerResult = await TypedWorker.create({
      contract: inprocessContract,
      connection: testEnv.nativeConnection,
      workflowsPath: fixturePath(import.meta.url, "inprocess.workflows"),
      activities,
    });
    expect(workerResult).toBeOk();
    if (!workerResult.isOk()) return;
    const worker = workerResult.value;

    const clientResult = await TypedClient.create({
      client: testEnv.client,
      interceptors: [recording],
    });
    expect(clientResult).toBeOk();
    if (!clientResult.isOk()) return;
    const client = clientResult.value.for(inprocessContract);

    await worker.raw.runUntil(async () => {
      // Happy path — the hour-long sleep is skipped, the accumulated
      // middleware context reaches the implementation.
      const charged = await client.executeWorkflow("placeOrder", {
        workflowId: "inprocess-ok",
        args: { orderId: "ORD-1", amount: 5 },
      });
      expect(charged).toBeOkWith({ status: "charged:tx-5-trace-1" });

      // Activity-declared typed error, rehydrated inside the workflow.
      const declined = await client.executeWorkflow("placeOrder", {
        workflowId: "inprocess-declined",
        args: { orderId: "ORD-2", amount: -1 },
      });
      expect(declined).toBeOkWith({ status: "declined:negative-amount" });

      // Workflow-declared typed error, rehydrated at the client.
      const empty = await client.executeWorkflow("placeOrder", {
        workflowId: "inprocess-empty",
        args: { orderId: "ORD-3", amount: 0 },
      });
      expect(empty).toBeErrTagged("@temporal-contract/ContractError");
      if (empty.isErr() && empty.error instanceof ContractError) {
        expect(empty.error.errorName).toBe("EmptyOrder");
        expect(empty.error.data).toEqual({ orderId: "ORD-3" });
      }
    });

    // Interceptors observed every operation, outermost of validation.
    expect(interceptedOperations).toEqual([
      "executeWorkflow",
      "executeWorkflow",
      "executeWorkflow",
    ]);
    // The createContext seed + middleware injection reached the
    // implementation (only the two executions that hit the activity).
    expect(seenContexts).toEqual([
      { gateway: "test-gateway", traceId: "trace-1" },
      { gateway: "test-gateway", traceId: "trace-1" },
    ]);
  });

  it("a workflow that re-raises cancellation via rethrowCancellation ends Cancelled", async ({
    testEnv,
  }) => {
    const workerResult = await TypedWorker.create({
      contract: inprocessContract,
      connection: testEnv.nativeConnection,
      workflowsPath: fixturePath(import.meta.url, "inprocess.workflows"),
      activities,
    });
    expect(workerResult).toBeOk();
    if (!workerResult.isOk()) return;
    const worker = workerResult.value;

    const clientResult = await TypedClient.create({ client: testEnv.client });
    expect(clientResult).toBeOk();
    if (!clientResult.isOk()) return;
    const client = clientResult.value.for(inprocessContract);

    await worker.raw.runUntil(async () => {
      const workflowId = "inprocess-cancelled-outcome";
      const started = await client.startWorkflow("waitForever", {
        workflowId,
        args: {},
      });
      expect(started).toBeOk();
      if (!started.isOk()) return;

      const cancelResult = await started.value.cancel();
      expect(cancelResult).toBeOk();

      // Await completion via the raw handle (the result rejects with the
      // cancellation failure — that rejection is the point), then assert the
      // terminal status Temporal recorded.
      const rawHandle = testEnv.client.workflow.getHandle(workflowId);
      await rawHandle.result().catch(() => undefined);
      const description = await rawHandle.describe();
      expect(description.status.name).toBe("CANCELLED");
    });
  });

  it("surfaces worker bundling failures on the defect channel — and the registration check silently skipped rather than reporting its own error", async ({
    testEnv,
  }) => {
    const workerResult = await TypedWorker.create({
      contract: inprocessContract,
      connection: testEnv.nativeConnection,
      workflowsPath: fixturePath(import.meta.url, "does-not-exist"),
      activities,
    });
    expect(workerResult).toBeDefect();
    if (workerResult.isDefect()) {
      const cause = workerResult.cause;
      expect(cause).toBeInstanceOf(TechnicalError);
      expect((cause as TechnicalError)._tag).toBe("@temporal-contract/TechnicalError");
      expect((cause as TechnicalError).message).toContain("inprocess-tests");
      // EFFECT: `workflowsPath` cannot be imported in the main thread either
      // — the registration check's best-effort import fails silently (per
      // its JSDoc, "a module that cannot be imported in the main thread is
      // skipped silently"), so this defect is `Worker.create`'s OWN real
      // bundler failure, not the check's "Workflow registration check
      // failed" diagnostic (that message is covered, with its own real
      // trigger, by `registration.inprocess.spec.ts`'s "no workflow export"
      // and "export-name mismatch" tests). Without this assertion, deleting
      // the check's silent-skip behavior (making it throw instead) would go
      // unnoticed here — the defect/TechnicalError shape stays identical
      // either way.
      expect((cause as TechnicalError).message).not.toContain("Workflow registration check");
      // EFFECT: the real bundler failure survives on `.cause` untouched — not
      // fabricated, not swallowed by the `TechnicalError` wrap at
      // `worker.ts`'s `create()` qualifier. Pinned on both sides: the cause
      // is a genuine `Error` (not e.g. a string) AND its own message names
      // the actual missing module, proving this is `Worker.create`'s bundler
      // error passed through, not a generic placeholder.
      expect((cause as TechnicalError).cause).toBeInstanceOf(Error);
      expect(((cause as TechnicalError).cause as Error).message).toContain("does-not-exist");
    }
  });

  it("passes through arbitrary WorkerOptions untouched — a custom identity reaches Temporal's own history", async ({
    testEnv,
  }) => {
    const workerResult = await TypedWorker.create({
      contract: inprocessContract,
      connection: testEnv.nativeConnection,
      workflowsPath: fixturePath(import.meta.url, "inprocess.workflows"),
      activities,
      identity: "custom-worker-identity-9000",
    });
    expect(workerResult).toBeOk();
    if (!workerResult.isOk()) return;
    const worker = workerResult.value;

    const clientResult = await TypedClient.create({ client: testEnv.client });
    expect(clientResult).toBeOk();
    if (!clientResult.isOk()) return;
    const client = clientResult.value.for(inprocessContract);

    const identity = await worker.raw.runUntil(async () => {
      // No `workflowExecutionTimeout` bound here — `placeOrder` deliberately
      // sleeps 1 SIMULATED hour to prove time skipping (see
      // `inprocess.workflows.ts`); under the time-skipping environment that
      // sleep resolves almost instantly in real time (the whole point of
      // this environment), but a 30-second bound would be measured against
      // the SAME simulated clock and trip long before the sleep ever
      // resolves. Matches the other tests in this file, which bind nothing
      // for the same reason.
      const handle = await client
        .startWorkflow("placeOrder", {
          workflowId: "inprocess-identity",
          args: { orderId: "ORD-IDENT", amount: 5 },
        })
        .getOrThrow();
      await handle.result().getOrThrow();

      const history = await handle.raw.fetchHistory();
      const completed = (history.events ?? []).find(
        (event) => event.eventType === WORKFLOW_TASK_COMPLETED_EVENT_TYPE,
      );
      return completed?.workflowTaskCompletedEventAttributes?.identity;
    });

    // EFFECT: Temporal's own record of who completed the workflow task
    // carries the EXACT identity string passed through `CreateWorkerOptions`
    // — proving arbitrary `WorkerOptions` fields (not just the ones this
    // typed layer names explicitly: `contract`, `activities`,
    // `verifyWorkflowRegistration`) reach the real `Worker.create` call
    // untouched, rather than being dropped by the options spread.
    expect(identity).toBe("custom-worker-identity-9000");
  });

  it("run() surfaces a genuine double-run failure on the defect channel", async ({ testEnv }) => {
    const workerResult = await TypedWorker.create({
      contract: inprocessContract,
      connection: testEnv.nativeConnection,
      workflowsPath: fixturePath(import.meta.url, "inprocess.workflows"),
      activities,
    });
    expect(workerResult).toBeOk();
    if (!workerResult.isOk()) return;
    const worker = workerResult.value;

    // `@temporalio/worker`'s `Worker.run()` is itself declared `async` (see
    // `runInternal` in its source), so calling it advances synchronously
    // past its `this.state = 'RUNNING'` assignment before yielding control
    // back here — no `await` precedes that line. The immediate second call
    // below therefore deterministically observes `state === 'RUNNING'` and
    // rejects with Temporal's own `IllegalStateError('Poller was already
    // started')`. Because `run()` is `async`, JS folds a throw from inside
    // it into the SAME rejected-promise path as any other async failure —
    // there is no code path in this codebase or Temporal's own `run()` that
    // throws synchronously instead of rejecting, so one real trigger proves
    // `TypedWorker.run()`'s `fromPromise` wrapping for both.
    const firstRun = worker.run();

    // Cleanup lives in `finally` so a failing assertion below — the precise
    // regression this test exists to catch — cannot leak a live worker still
    // polling in the worker-process-scoped time-skipping environment (shared
    // across every other test in this file and process).
    try {
      const secondRunResult = await worker.run();

      expect(secondRunResult).toBeDefect();
      if (secondRunResult.isDefect()) {
        const cause = secondRunResult.cause;
        expect(cause).toBeInstanceOf(TechnicalError);
        expect((cause as TechnicalError).message).toContain(
          `task queue "${inprocessContract.taskQueue}"`,
        );
        expect((cause as TechnicalError).message).toContain("failed while running");
        // EFFECT: the real underlying error survived on `.cause` untouched —
        // not fabricated, not swallowed.
        expect((cause as TechnicalError).cause).toBeInstanceOf(Error);
        expect(((cause as TechnicalError).cause as Error).message).toBe(
          "Poller was already started",
        );
      }
    } finally {
      worker.shutdown();
      await firstRun.get();
    }
  });
});
