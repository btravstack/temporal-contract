import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import { ApplicationFailure } from "@temporalio/workflow";

import { declareWorkflow } from "../workflow.js";
import { childIdempotencyContract } from "./child-idempotency.contract.js";

export const onceChild = declareWorkflow({
  workflowName: "onceChild",
  contract: childIdempotencyContract,
  implementation: async (_context, args) => ({ ok: !args.shouldFail }),
});

/**
 * Turns an unexpected defect into a terminal `ApplicationFailure` instead of
 * a bare throw. A raw non-`TemporalFailure` throw would otherwise put the
 * workflow task into a retry loop that never closes the run — hanging this
 * fixture to the spec's execution timeout instead of failing fast with a
 * readable cause. None of the scenarios this fixture drives expect a defect;
 * if one ever occurs, this keeps the failure terminal and inspectable.
 */
function failOnDefect(cause: unknown): never {
  throw ApplicationFailure.create({
    type: "UnexpectedDefect",
    message: `child-idempotency fixture: unexpected defect: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
  });
}

/**
 * `createStartChildWorkflow`/`createExecuteChildWorkflow`'s `Err` union also
 * includes `ChildWorkflowNotFoundError` (raised only when the child name is
 * missing from the contract — never true for `"onceChild"` here), which
 * carries no `.cause`. Narrow with `in` rather than a cast so a real
 * `ChildWorkflowNotFoundError` still yields a usable (if generic) value
 * instead of `undefined` silently defeating the `instanceof` check below.
 */
function causeOf(error: { cause?: unknown }): unknown {
  return "cause" in error ? error.cause : error;
}

export const parent = declareWorkflow({
  workflowName: "parent",
  contract: childIdempotencyContract,
  // Starts (or executes) `onceChild` twice under the SAME `childWorkflowId`,
  // awaiting the first attempt's full completion before the second — so the
  // second attempt always races a *Closed* prior run, exactly the case
  // `workflowIdReusePolicy` governs. `args.mode` picks which child-start path
  // (`startChildWorkflow` vs. `executeChildWorkflow`) is under test;
  // `args.overridePolicy`, when set, rides only on the SECOND attempt.
  implementation: async (context, args) => {
    async function attempt(
      overridePolicy: "ALLOW_DUPLICATE" | undefined,
    ): Promise<{ ok: true; value: { ok: boolean } } | { ok: false; cause: unknown }> {
      const options = {
        workflowId: args.childWorkflowId,
        args: { shouldFail: false },
        ...(overridePolicy ? { workflowIdReusePolicy: overridePolicy } : {}),
      };

      if (args.mode === "start") {
        const handleResult = await context.startChildWorkflow(
          childIdempotencyContract,
          "onceChild",
          options,
        );
        if (handleResult.isDefect()) failOnDefect(handleResult.cause);
        if (handleResult.isErr()) return { ok: false, cause: causeOf(handleResult.error) };

        const runResult = await handleResult.value.result();
        if (runResult.isDefect()) failOnDefect(runResult.cause);
        if (runResult.isErr()) return { ok: false, cause: causeOf(runResult.error) };
        return { ok: true, value: runResult.value };
      }

      const execResult = await context.executeChildWorkflow(
        childIdempotencyContract,
        "onceChild",
        options,
      );
      if (execResult.isDefect()) failOnDefect(execResult.cause);
      if (execResult.isErr()) return { ok: false, cause: causeOf(execResult.error) };
      return { ok: true, value: execResult.value };
    }

    const first = await attempt(undefined);
    const second = await attempt(args.overridePolicy);

    return {
      firstOk: first.ok,
      secondOk: second.ok,
      // The identity check that actually pins this to `workflowIdReusePolicy`
      // rather than "something, anything, went wrong": Temporal raises this
      // SPECIFIC failure only for a duplicate-workflow-ID rejection.
      secondRejectedAsAlreadyStarted:
        !second.ok && second.cause instanceof WorkflowExecutionAlreadyStartedError,
    };
  },
});
