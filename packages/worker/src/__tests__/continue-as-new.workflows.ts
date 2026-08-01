import { declareWorkflow } from "../workflow.js";
import { continueAsNewContract, otherContract } from "./continue-as-new.contract.js";

export const accumulate = declareWorkflow({
  workflowName: "accumulate",
  contract: continueAsNewContract,
  implementation: async (context, args) => {
    const total = args.total + args.cursor;

    // Three runs total: cursor 3 -> 2 -> 1 -> done, proving state crosses
    // TWO continue-as-new boundaries.
    if (args.cursor > 1) {
      const nextArgs = { cursor: args.cursor - 1, total, smuggle: args.smuggle };
      if (args.smuggle) {
        // THE ATTACK: a smuggled workflowType/taskQueue override, reachable
        // only by bypassing the typed options (which Omit both fields) via
        // `as never` — the same escape hatch a hostile or buggy caller
        // would need in real code. `createContinueAsNew` sets the validated
        // target LAST, after the user-options spread, so this must have NO
        // effect: the continuation still lands on `accumulate` /
        // `continueAsNewContract`'s real task queue, never "evil"/
        // "evil-queue" (which no worker polls — if the smuggle ever DID
        // win, the run would never be picked up, and the test's
        // `workflowExecutionTimeout` bound turns that into a terminal,
        // assertable TimedOut instead of a hang).
        await context.continueAsNew(nextArgs, {
          workflowType: "evil",
          taskQueue: "evil-queue",
        } as never);
      } else {
        // EFFECT (options forwarding): a real user option (`memo`) genuinely
        // reaches Temporal's continueAsNew — observable afterwards via
        // `handle.raw.describe().memo` on the final run.
        await context.continueAsNew(nextArgs, { memo: { hop: String(args.cursor - 1) } });
      }
    }

    return { total };
  },
});

export const invalidContinuation = declareWorkflow({
  workflowName: "invalidContinuation",
  contract: continueAsNewContract,
  implementation: async (context) => {
    // `invalidContinuation`'s own input schema requires `n: number` — this
    // continuation deliberately violates it. `createContinueAsNew` validates
    // BEFORE calling Temporal, so this must throw
    // `WorkflowInputValidationError` synchronously, never reaching the wire.
    return context.continueAsNew({ n: "not-a-number" } as never);
  },
});

export const transformOnce = declareWorkflow({
  workflowName: "transformOnce",
  contract: continueAsNewContract,
  implementation: async (context, args) => {
    if (args.hops < 1) {
      // A fresh literal, deliberately NOT derived from `args.text` (already
      // transformed once by this run's own receive-parse) — the only source
      // of a SECOND "!" on the next run can be `createContinueAsNew`
      // wrongly sending the schema-PARSED value instead of these original,
      // pre-parse args.
      await context.continueAsNew({ text: "seed", hops: args.hops + 1 });
    }
    return { text: args.text };
  },
});

export const crossContractDispatcher = declareWorkflow({
  workflowName: "crossContractDispatcher",
  contract: continueAsNewContract,
  implementation: async (context, args) => {
    // Scope `otherContract` to the SAME per-test task queue the caller's
    // worker is already listening on (statically importing `otherContract`
    // would carry its default task queue, which no worker in this test
    // polls).
    const scopedOtherContract = { ...otherContract, taskQueue: args.otherTaskQueue };

    switch (args.mode) {
      case "valid":
        return context.continueAsNew(scopedOtherContract, "archive", { batchId: "B-1" });
      case "invalidArgs":
        // `archive`'s input schema requires `batchId: string`.
        return context.continueAsNew(scopedOtherContract, "archive", { batchId: 123 } as never);
      case "undeclaredTarget": {
        // "ghost" is not a workflow `otherContract` declares — cast the
        // whole call (not just the name) so the generic overload's
        // `args`-from-`workflowName` inference doesn't collapse to `never`.
        const bypass = context.continueAsNew as unknown as (
          contract: typeof scopedOtherContract,
          workflowName: string,
          args: unknown,
        ) => Promise<never>;
        return bypass(scopedOtherContract, "ghost", { batchId: "B-1" });
      }
    }
  },
});

export const archive = declareWorkflow({
  workflowName: "archive",
  contract: otherContract,
  implementation: async (_context, args) => {
    return { batchId: args.batchId };
  },
});

export const dispatchHeuristic = declareWorkflow({
  workflowName: "dispatchHeuristic",
  contract: continueAsNewContract,
  implementation: async (context, args) => {
    if (args.hop < 1) {
      if (args.mode === "treacherous-shape") {
        // Single positional arg: `args` structurally looks like a contract
        // (string `taskQueue` + object `workflows`), but
        // `createContinueAsNew`'s dispatch heuristic requires a STRING
        // second argument before it ever treats a call as cross-contract.
        // Omitting arg2 here must stay same-workflow regardless of arg1's
        // shape.
        await context.continueAsNew({ ...args, hop: args.hop + 1 });
      } else {
        // "null-workflows": arg2 IS a string this time, but `args.workflows`
        // is `null` — `typeof null === "object"` is the trap the
        // heuristic's null-safety check exists to avoid. Reaching this
        // two-positional-argument shape from the same-workflow overload
        // requires bypassing the typed surface (which Omits it entirely)
        // exactly like a hostile/buggy caller would have to.
        const bypass = context.continueAsNew as unknown as (
          arg1: unknown,
          arg2: unknown,
        ) => Promise<never>;
        await bypass({ ...args, hop: args.hop + 1 }, "ignored-target-name");
      }
    }
    return { status: "completed-same-workflow" };
  },
});
