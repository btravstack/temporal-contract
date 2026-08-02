import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

// Composition-first: resources defined individually, then composed.

/**
 * Two declared errors identical but for `nonRetryable`. Each `retry.inprocess.spec.ts`
 * test supplies its own activity handler that hardcodes which one to raise —
 * `mode` only threads client → workflow → activity input, unread by the
 * handler itself — so a single fixture proves both directions and the only
 * variable between them is the flag under test.
 *
 * `maximumAttempts: 3` bounds the retryable case: it must retry (proving the
 * flag reached Temporal) without retrying forever if the flag regresses.
 */
const flaky = defineActivity({
  input: z.object({ mode: z.enum(["terminal", "retryable"]) }),
  output: z.object({ attempts: z.number() }),
  errors: {
    TerminalFailure: { data: z.object({ at: z.number() }), nonRetryable: true },
    RetryableFailure: { data: z.object({ at: z.number() }), nonRetryable: false },
  },
  activityOptions: {
    startToCloseTimeout: "10 seconds",
    retry: { maximumAttempts: 3, backoffCoefficient: 1, initialInterval: "1 second" },
  },
});

const runsFlaky = defineWorkflow({
  input: z.object({ mode: z.enum(["terminal", "retryable"]) }),
  output: z.object({ outcome: z.string(), attempts: z.number() }),
  activities: { flaky },
});

export const retryContract = defineContract({
  taskQueue: "retry-tests",
  workflows: { runsFlaky },
});
