import { ApplicationFailure } from "@temporalio/workflow";

import { declareWorkflow } from "../workflow.js";
import { idempotencyContract } from "./idempotency.contract.js";

/**
 * Shared body for all three modes. `shouldFail` decides whether the run
 * completes or fails, so the same fixture produces both a Completed and a
 * Failed run for `idempotency.inprocess.spec.ts` to start a second time
 * against.
 *
 * The failure is thrown as an `ApplicationFailure` — a `TemporalFailure` —
 * so Temporal records the run as FAILED. A plain thrown `Error` would
 * instead become a Workflow-Task retry loop that never closes the run,
 * which the dedup specs (rejected/allowed against a *Closed* run) could
 * never observe.
 */
async function run(args: { shouldFail: boolean }): Promise<{ ok: boolean }> {
  if (args.shouldFail) {
    throw ApplicationFailure.create({
      type: "DeliberateFailure",
      message: "idempotency fixture: shouldFail was true",
      nonRetryable: true,
    });
  }
  return { ok: true };
}

export const onceWorkflow = declareWorkflow({
  workflowName: "onceWorkflow",
  contract: idempotencyContract,
  implementation: async (_context, args) => run(args),
});

export const retryWorkflow = declareWorkflow({
  workflowName: "retryWorkflow",
  contract: idempotencyContract,
  implementation: async (_context, args) => run(args),
});

export const allowWorkflow = declareWorkflow({
  workflowName: "allowWorkflow",
  contract: idempotencyContract,
  implementation: async (_context, args) => run(args),
});
