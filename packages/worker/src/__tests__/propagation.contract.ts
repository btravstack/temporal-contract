import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

/**
 * Fails on every attempt and declares NO `errors` map. Before the
 * uniform-`AsyncResult` change, this activity's workflow-side call took the
 * (now-deleted) `makeThrowingActivity` path, and Temporal's original
 * `ActivityFailure` propagated out of the workflow via a bare `await`. This
 * is the activity whose observable behavior — now reached through
 * `propagateActivityFailure`, or handled by narrowing `isErr()` — must stay
 * IDENTICAL to that pre-change throwing behavior.
 *
 * `maximumAttempts: 2` bounds the run: enough to prove Temporal retried,
 * short enough that a regression cannot stall the suite.
 */
const alwaysFailsNoErrors = defineActivity({
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  activityOptions: {
    startToCloseTimeout: "5 seconds",
    retry: { maximumAttempts: 2, backoffCoefficient: 1, initialInterval: "1 second" },
  },
});

/** The same, but declaring an error — already on the Result path today. */
const alwaysFailsWithErrors = defineActivity({
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  errors: {
    Boom: { data: z.object({ at: z.number() }), nonRetryable: true },
  },
  activityOptions: {
    startToCloseTimeout: "5 seconds",
    retry: { maximumAttempts: 2, backoffCoefficient: 1, initialInterval: "1 second" },
  },
});

/** Lets the activity failure escape, so Temporal decides the workflow outcome. */
const propagatesFailure = defineWorkflow({
  input: z.object({}),
  output: z.object({ reached: z.boolean() }),
  idempotency: "allow-duplicate",
  activities: { alwaysFailsNoErrors },
});

/** Catches the failure and returns normally, so the workflow completes. */
const handlesFailure = defineWorkflow({
  input: z.object({}),
  output: z.object({ outcome: z.string() }),
  idempotency: "allow-duplicate",
  activities: { alwaysFailsNoErrors },
});

export const propagationContract = defineContract({
  taskQueue: "propagation-tests",
  workflows: { propagatesFailure, handlesFailure },
  activities: { alwaysFailsWithErrors },
});
