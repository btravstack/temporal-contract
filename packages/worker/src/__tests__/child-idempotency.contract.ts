import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

/**
 * Contract for `child-idempotency.inprocess.spec.ts` — real (time-skipping
 * server) coverage of contract-declared idempotency at the CHILD-WORKFLOW
 * boundary (`context.startChildWorkflow` / `context.executeChildWorkflow`),
 * mirroring `idempotency.contract.ts`'s coverage of the top-level client
 * paths.
 *
 * `onceChild` declares `"once-per-id"` so its default policy
 * (REJECT_DUPLICATE) is distinguishable from Temporal's own default
 * (ALLOW_DUPLICATE) — a test asserting the wrong/no policy would still pass
 * against the default, so the mode is chosen deliberately (same rationale as
 * `idempotency.contract.ts`'s `onceWorkflow`).
 */
const childInput = z.object({ shouldFail: z.boolean() });
const childOutput = z.object({ ok: z.boolean() });

const onceChild = defineWorkflow({
  input: childInput,
  output: childOutput,
  idempotency: "once-per-id",
});

/**
 * Drives a single parent execution that starts (or executes) `onceChild`
 * TWICE under the SAME `childWorkflowId`, awaiting the first attempt's full
 * completion before making the second — so the second attempt is always
 * racing a *Closed* (not merely Running) prior execution, exactly the case
 * `workflowIdReusePolicy` governs. `mode` selects `startChildWorkflow` vs.
 * `executeChildWorkflow` so both child-start paths get independent coverage
 * from the same fixture. `overridePolicy`, when set, is passed as an
 * explicit per-call `workflowIdReusePolicy` on the SECOND attempt only, to
 * prove an explicit override still wins over the contract's declared mode.
 */
const parent = defineWorkflow({
  input: z.object({
    mode: z.enum(["start", "execute"]),
    childWorkflowId: z.string(),
    overridePolicy: z.literal("ALLOW_DUPLICATE").optional(),
  }),
  output: z.object({
    firstOk: z.boolean(),
    secondOk: z.boolean(),
    // Whether the second attempt's rejection was SPECIFICALLY a duplicate
    // workflow ID rejection (Temporal's `WorkflowExecutionAlreadyStartedError`)
    // rather than some other failure — the identity check that actually pins
    // this to `workflowIdReusePolicy`, not just "something went wrong".
    secondRejectedAsAlreadyStarted: z.boolean(),
  }),
  // Each test starts `parent` under a fresh, unique workflow ID (see the
  // spec file), so `parent` itself is never re-run under a reused ID — its
  // own idempotency mode is not under test here. `"allow-duplicate"` is
  // Temporal's own default, chosen so it stays inert.
  idempotency: "allow-duplicate",
});

export const childIdempotencyContract = defineContract({
  taskQueue: "child-idempotency-tests",
  workflows: { onceChild, parent },
});
