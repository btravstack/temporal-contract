import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

/**
 * Contract for `continue-as-new.inprocess.spec.ts` — real (time-skipping
 * server, real `@temporalio/workflow.makeContinueAsNewFunc`) coverage of
 * `context.continueAsNew(...)`.
 */
export const continueAsNewContract = defineContract({
  taskQueue: "continue-as-new-tests",
  workflows: {
    /**
     * Counts down `cursor` by one on each continuation, folding it into
     * `total`. Three runs total (cursor 3 -> 2 -> 1 -> done) proves state
     * survives TWO continue-as-new boundaries. `smuggle: true` makes every
     * continuation attempt a `workflowType`/`taskQueue` override via the
     * options bag (the "validated target wins" probe); otherwise each
     * continuation forwards a `memo` (the "user options really reach
     * Temporal" probe).
     */
    accumulate: defineWorkflow({
      input: z.object({ cursor: z.number(), total: z.number(), smuggle: z.boolean().optional() }),
      output: z.object({ total: z.number() }),
    }),

    /**
     * Deliberately continues itself with args that violate its OWN input
     * schema — proves `createContinueAsNew` validates before ever calling
     * Temporal, on the same-workflow dispatch branch.
     */
    invalidContinuation: defineWorkflow({
      input: z.object({ n: z.number() }),
      output: z.object({}),
    }),

    /**
     * `text`'s schema transforms on parse. Proves `continueAsNew` transmits
     * the ORIGINAL (pre-parse) args, not the schema-parsed value — a
     * transforming schema must not be applied twice across one boundary.
     */
    transformOnce: defineWorkflow({
      input: z.object({ text: z.string().transform((s) => `${s}!`), hops: z.number() }),
      output: z.object({ text: z.string() }),
    }),

    /**
     * Drives the three cross-contract dispatch scenarios (valid target,
     * invalid args against the destination schema, undeclared target) named
     * by `mode`. `otherTaskQueue` lets the test scope `otherContract` to the
     * SAME per-test task queue as this contract, so one worker can serve
     * both sides of the cross-contract call.
     */
    crossContractDispatcher: defineWorkflow({
      input: z.object({
        mode: z.enum(["valid", "invalidArgs", "undeclaredTarget"]),
        otherTaskQueue: z.string(),
      }),
      output: z.object({}),
    }),

    /**
     * Drives the dispatch-heuristic edge cases: same-workflow args that
     * structurally resemble a contract (`taskQueue` + `workflows` keys)
     * must not be misclassified as a cross-contract call.
     */
    dispatchHeuristic: defineWorkflow({
      input: z.object({
        hop: z.number(),
        mode: z.enum(["treacherous-shape", "null-workflows"]),
        taskQueue: z.string(),
        workflows: z.union([z.record(z.string(), z.unknown()), z.null()]),
      }),
      output: z.object({ status: z.string() }),
    }),
  },
});

/** Cross-contract destination for `crossContractDispatcher`'s "valid"/"invalidArgs" modes. */
export const otherContract = defineContract({
  taskQueue: "continue-as-new-other-tests",
  workflows: {
    archive: defineWorkflow({
      input: z.object({ batchId: z.string() }),
      output: z.object({ batchId: z.string() }),
    }),
  },
});
