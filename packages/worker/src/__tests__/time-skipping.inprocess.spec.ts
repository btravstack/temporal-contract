import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { ContractError, TypedClient, type ClientInterceptor } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
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

function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}

describe("time-skipping TestWorkflowEnvironment", () => {
  it("runs the full contract pipeline in-process", async ({ testEnv }) => {
    const workerResult = await TypedWorker.create({
      contract: inprocessContract,
      connection: testEnv.nativeConnection,
      workflowsPath: workflowPath("inprocess.workflows"),
      activities,
    });
    expect(workerResult.isOk()).toBe(true);
    if (!workerResult.isOk()) return;
    const worker = workerResult.value;

    const clientResult = await TypedClient.create({
      client: testEnv.client,
      interceptors: [recording],
    });
    expect(clientResult.isOk()).toBe(true);
    if (!clientResult.isOk()) return;
    const client = clientResult.value.for(inprocessContract);

    await worker.raw.runUntil(async () => {
      // Happy path — the hour-long sleep is skipped, the accumulated
      // middleware context reaches the implementation.
      const charged = await client.executeWorkflow("placeOrder", {
        workflowId: "inprocess-ok",
        args: { orderId: "ORD-1", amount: 5 },
      });
      expect(charged.isOk()).toBe(true);
      if (charged.isOk()) {
        expect(charged.value.status).toBe("charged:tx-5-trace-1");
      }

      // Activity-declared typed error, rehydrated inside the workflow.
      const declined = await client.executeWorkflow("placeOrder", {
        workflowId: "inprocess-declined",
        args: { orderId: "ORD-2", amount: -1 },
      });
      expect(declined.isOk()).toBe(true);
      if (declined.isOk()) {
        expect(declined.value.status).toBe("declined:negative-amount");
      }

      // Workflow-declared typed error, rehydrated at the client.
      const empty = await client.executeWorkflow("placeOrder", {
        workflowId: "inprocess-empty",
        args: { orderId: "ORD-3", amount: 0 },
      });
      expect(empty.isErr()).toBe(true);
      if (empty.isErr()) {
        expect(empty.error).toBeInstanceOf(ContractError);
        if (empty.error instanceof ContractError) {
          expect(empty.error.errorName).toBe("EmptyOrder");
          expect(empty.error.data).toEqual({ orderId: "ORD-3" });
        }
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
      workflowsPath: workflowPath("inprocess.workflows"),
      activities,
    });
    expect(workerResult.isOk()).toBe(true);
    if (!workerResult.isOk()) return;
    const worker = workerResult.value;

    const clientResult = await TypedClient.create({ client: testEnv.client });
    expect(clientResult.isOk()).toBe(true);
    if (!clientResult.isOk()) return;
    const client = clientResult.value.for(inprocessContract);

    await worker.raw.runUntil(async () => {
      const workflowId = "inprocess-cancelled-outcome";
      const started = await client.startWorkflow("waitForever", {
        workflowId,
        args: {},
      });
      expect(started.isOk()).toBe(true);
      if (!started.isOk()) return;

      const cancelResult = await started.value.cancel();
      expect(cancelResult.isOk()).toBe(true);

      // Await completion via the raw handle (the result rejects with the
      // cancellation failure — that rejection is the point), then assert the
      // terminal status Temporal recorded.
      const rawHandle = testEnv.client.workflow.getHandle(workflowId);
      await rawHandle.result().catch(() => undefined);
      const description = await rawHandle.describe();
      expect(description.status.name).toBe("CANCELLED");
    });
  });

  it("surfaces worker bundling failures on the defect channel", async ({ testEnv }) => {
    const workerResult = await TypedWorker.create({
      contract: inprocessContract,
      connection: testEnv.nativeConnection,
      workflowsPath: workflowPath("does-not-exist"),
      activities,
    });
    expect(workerResult.isDefect()).toBe(true);
    if (workerResult.isDefect()) {
      const cause = workerResult.cause;
      expect(cause).toBeInstanceOf(TechnicalError);
      expect((cause as TechnicalError)._tag).toBe("@temporal-contract/TechnicalError");
      expect((cause as TechnicalError).message).toContain("inprocess-tests");
    }
  });
});
