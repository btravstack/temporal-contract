import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import { ContractError, TypedClient, type ClientInterceptor } from "@temporal-contract/client";
import { it } from "@temporal-contract/testing/time-skipping";
import { Ok, Err, type AsyncResult } from "unthrown";
/**
 * Full contract-pipeline coverage against the time-skipping
 * `TestWorkflowEnvironment` (`@temporal-contract/testing/time-skipping`) —
 * no Docker required. Exercises, in-process:
 *
 * - `createWorker` / `TypedClient.create` AsyncResult factories,
 * - validation on both sides of the activity boundary,
 * - `createContext` seed + accumulating middleware context,
 * - typed contract errors (activity-side rehydration in the workflow,
 *   workflow-side rehydration at the client),
 * - client interceptors observing every operation,
 * - contract-level `defaultOptions` standing in for `activityOptions`,
 * - time skipping (an hour-long `sleep` resolving immediately).
 */
import { describe, expect } from "vitest";

import {
  composeActivityMiddleware,
  declareActivitiesHandler,
  defineActivityMiddleware,
} from "../activity.js";
import { createWorker } from "../worker.js";
import { inprocessContract } from "./inprocess.contract.js";

const okAsync = <T>(value: T): AsyncResult<T, never> => Ok(value).toAsync();
const errAsync = <E>(error: E): AsyncResult<never, E> => Err(error).toAsync();

const seenContexts: Record<string, unknown>[] = [];

const tracing = composeActivityMiddleware(
  defineActivityMiddleware<{ gateway: string }, { gateway: string; traceId: string }>(
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
          return errAsync(errors.PaymentDeclined({ reason: "negative-amount" }));
        }
        return okAsync({ transactionId: `tx-${amount}-${context.traceId}` });
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
    const workerResult = await createWorker({
      contract: inprocessContract,
      connection: testEnv.nativeConnection,
      workflowsPath: workflowPath("inprocess.workflows"),
      activities,
    });
    expect(workerResult.isOk()).toBe(true);
    if (!workerResult.isOk()) return;
    const worker = workerResult.value;

    const clientResult = await TypedClient.create({
      contract: inprocessContract,
      client: testEnv.client,
      interceptors: [recording],
    });
    expect(clientResult.isOk()).toBe(true);
    if (!clientResult.isOk()) return;
    const client = clientResult.value;

    await worker.runUntil(async () => {
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

  it("surfaces worker bundling failures on the Err channel", async ({ testEnv }) => {
    const workerResult = await createWorker({
      contract: inprocessContract,
      connection: testEnv.nativeConnection,
      workflowsPath: workflowPath("does-not-exist"),
      activities,
    });
    expect(workerResult.isErr()).toBe(true);
    if (workerResult.isErr()) {
      expect(workerResult.error._tag).toBe("@temporal-contract/TechnicalError");
      expect(workerResult.error.message).toContain("inprocess-tests");
    }
  });
});
