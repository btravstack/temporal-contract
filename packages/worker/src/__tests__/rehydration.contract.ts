import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

// Contract pair for the rehydration audit-gap specs
// (`rehydration.inprocess.spec.ts`). Two contracts share the task queue and
// workflow shape; only the *client-side* declaration of `QuoteExpired`'s
// data schema differs, modeling contract skew between a deployed worker and
// a consumer that shipped a stricter schema.

/**
 * `charge` declares a **data-less** error, the shape whose rehydration is
 * gated on the wire marker: without `details[1] = { $tc: 1 }`, any unrelated
 * `ApplicationFailure` reusing the name as its `type` must NOT surface as
 * the typed error.
 */
const charge = defineActivity({
  input: z.object({ mode: z.string() }),
  output: z.object({ ok: z.boolean() }),
  errors: {
    AlreadyCharged: { nonRetryable: true },
  },
  activityOptions: { startToCloseTimeout: "10 seconds", retry: { maximumAttempts: 3 } },
});

const quote = defineWorkflow({
  input: z.object({ mode: z.string() }),
  output: z.object({ classification: z.string() }),
  startPolicy: "allow-duplicate",
  errors: {
    QuoteExpired: {
      data: z.object({ quoteId: z.string() }),
      message: "Quote has expired",
      nonRetryable: true,
    },
  },
  activities: { charge },
});

/** The contract the worker (and its workflow module) is deployed with. */
export const rehydrationWorkerContract = defineContract({
  taskQueue: "rehydration-inprocess",
  workflows: { quote },
});

// Client-side skewed twin: identical except `QuoteExpired.data` is STRICTER
// than what the worker validates against — `quoteId` must start with "Q-".
// A worker emitting `{ quoteId: "legacy-1" }` is valid on its side but fails
// this schema on rehydration.
const quoteSkewed = defineWorkflow({
  input: z.object({ mode: z.string() }),
  output: z.object({ classification: z.string() }),
  startPolicy: "allow-duplicate",
  errors: {
    QuoteExpired: {
      data: z.object({ quoteId: z.string().startsWith("Q-") }),
      nonRetryable: true,
    },
  },
  activities: { charge },
});

/** The stricter contract a consumer binds on the client side. */
export const rehydrationClientContract = defineContract({
  taskQueue: "rehydration-inprocess",
  workflows: { quote: quoteSkewed },
});
