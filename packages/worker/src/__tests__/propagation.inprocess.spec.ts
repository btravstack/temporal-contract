import { testRig } from "@temporal-contract/testing/test-rig";
import { it } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { Context } from "@temporalio/activity";
import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { declareActivitiesHandler } from "../activity.js";
import { propagationContract } from "./propagation.contract.js";

// Short, so a workflow-TASK retry loop (the failure mode a wrong propagation
// helper produces) times out fast instead of stalling the suite for 120s.
const WORKFLOW_EXECUTION_TIMEOUT = "10 seconds";

// `alwaysFailsWithErrors` is declared on the contract's global `activities`
// block (Task 3's fixture, unused here — see propagation.contract.ts) but
// `declareActivitiesHandler` requires an implementation for every declared
// activity regardless of whether this task's tests invoke it. It is never
// called by either workflow under test.
const alwaysFailsWithErrors = () => OkAsync({ ok: true });

/**
 * These tests are a CHARACTERIZATION of behavior that must survive the
 * uniform-`AsyncResult` change. They are written against the pre-change
 * implementation and must pass unmodified afterwards. Do not adjust them to
 * match new behavior — a diff here means the change altered semantics.
 */
describe("activity failure propagation — characterization", () => {
  it("fails the workflow, after Temporal's own retries, when the failure escapes", async ({
    testEnv,
  }) => {
    const contract = withTaskQueue(propagationContract, nextTaskQueueId("prop-escape"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "propagation.workflows"));

    const attempts: number[] = [];
    // `alwaysFailsNoErrors` is declared on both `propagatesFailure` and
    // `handlesFailure`, so it shares one flat runtime namespace name.
    // `declareActivitiesHandler` requires the exact same function reference
    // from every scope that declares it (see activity.ts's `shouldRegister`)
    // — passing two different closures throws a declaration-time config
    // error, even though only one workflow is exercised per test.
    //
    // Synchronous (not `async`), not `AsyncResult`-returning: the handler's
    // TYPE always demands `AsyncResult` (`ResultActivityImplementation`), but
    // an `async () => { throw }` infers `Promise<never>`, which doesn't
    // satisfy it. A plain `() => never` does, because `never` is assignable
    // to any type — and at runtime a synchronous throw inside this callback
    // rejects the wrapper's promise identically to an async throw, so the
    // Activity Task failure Temporal observes is unchanged.
    const alwaysFailsNoErrors = (): never => {
      attempts.push(Context.current().info.attempt);
      // oxlint-disable-next-line unthrown/no-throw -- the activity under test must fail
      throw new Error("activity exploded");
    };
    const activities = declareActivitiesHandler({
      contract,
      activities: {
        alwaysFailsWithErrors,
        propagatesFailure: { alwaysFailsNoErrors },
        handlesFailure: { alwaysFailsNoErrors },
      },
    });

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    const outcome = await worker.raw.runUntil(
      (async () => {
        const result = await client.executeWorkflow("propagatesFailure", {
          workflowId: "prop-escape",
          args: {},
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        });
        return result.isErr() ? "failed" : "completed";
      })(),
    );

    // The workflow must FAIL — not complete, and not spin in task retries
    // until the execution timeout. And Temporal must have retried the
    // activity to its configured maximum, proving the retry policy reached
    // the server rather than being short-circuited client-side.
    expect(outcome).toBe("failed");
    expect(attempts).toEqual([1, 2]);
  });

  it("completes the workflow when the failure is caught", async ({ testEnv }) => {
    const contract = withTaskQueue(propagationContract, nextTaskQueueId("prop-handled"));
    const bundle = await bundleFor(fixturePath(import.meta.url, "propagation.workflows"));

    // Same flat-namespace constraint, and same sync-throw-typechecks-as-never
    // reasoning, as the previous test.
    const alwaysFailsNoErrors = (): never => {
      // oxlint-disable-next-line unthrown/no-throw -- the activity under test must fail
      throw new Error("activity exploded");
    };
    const activities = declareActivitiesHandler({
      contract,
      activities: {
        alwaysFailsWithErrors,
        propagatesFailure: { alwaysFailsNoErrors },
        handlesFailure: { alwaysFailsNoErrors },
      },
    });

    const { worker, client } = await testRig(testEnv, { contract, bundle, activities });

    const result = await worker.raw.runUntil(
      client
        .executeWorkflow("handlesFailure", {
          workflowId: "prop-handled",
          args: {},
          workflowExecutionTimeout: WORKFLOW_EXECUTION_TIMEOUT,
        })
        .getOrThrow(),
    );

    expect(result).toEqual({ outcome: "handled" });
  });
});
