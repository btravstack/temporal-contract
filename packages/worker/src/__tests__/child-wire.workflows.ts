import { condition } from "@temporalio/workflow";

import { declareWorkflow } from "../workflow.js";
import { childWireContract } from "./child-wire.contract.js";

/**
 * Folds a defect's cause into a returned status string instead of rethrowing
 * — see `cancellation.workflows.ts`'s `describeDefect` for the rationale.
 * None of the paths below expect a defect; if one ever occurs, this keeps
 * the execution terminal and the cause inspectable from the test instead of
 * hanging to the execution timeout.
 */
function describeDefect(cause: unknown): string {
  return `defect:${cause instanceof Error ? cause.message : String(cause)}`;
}

export const entryTransform = declareWorkflow({
  workflowName: "entryTransform",
  contract: childWireContract,
  // Echoes back exactly what it received (`text`) and a literal (`n: 21`) —
  // see the contract's doc comment for why this proves both wire-format
  // boundaries at once.
  implementation: async (_context, args) => ({ text: args.text, n: 21 }),
});

export const entryInvalidOutput = declareWorkflow({
  workflowName: "entryInvalidOutput",
  contract: childWireContract,
  implementation: async () => ({ n: "not-a-number" }) as never,
});

export const child = declareWorkflow({
  workflowName: "child",
  contract: childWireContract,
  implementation: async (_context, args) => ({ label: args.label, n: 21 }),
});

export const parentChild = declareWorkflow({
  workflowName: "parentChild",
  contract: childWireContract,
  implementation: async (context, args) => {
    const childWorkflowId = `${context.info.workflowId}-child`;

    if (args.mode === "execute") {
      const result = await context.executeChildWorkflow(childWireContract, "child", {
        workflowId: childWorkflowId,
        args: { label: args.label },
      });
      if (result.isDefect()) return { status: describeDefect(result.cause) };
      if (result.isErr()) return { status: `err:${result.error._tag}` };
      return { status: "ok", label: result.value.label, n: result.value.n };
    }

    // mode === "start"
    const handleResult = await context.startChildWorkflow(childWireContract, "child", {
      workflowId: childWorkflowId,
      args: { label: args.label },
    });
    if (handleResult.isDefect()) return { status: describeDefect(handleResult.cause) };
    if (handleResult.isErr()) return { status: `err:${handleResult.error._tag}` };

    const handle = handleResult.value;
    const result = await handle.result();
    if (result.isDefect()) return { status: describeDefect(result.cause) };
    if (result.isErr()) return { status: `err:${result.error._tag}` };

    return {
      status: "ok",
      label: result.value.label,
      n: result.value.n,
      firstExecutionRunId: handle.firstExecutionRunId,
      // `handle.workflowId`, NOT the locally computed `childWorkflowId` —
      // proves the typed handle's own `workflowId` passthrough (not just
      // the caller's own input echoed back), matching the original mocked
      // spec's `expect(handleResult.value.workflowId).toBe("child-1")`.
      childWorkflowId: handle.workflowId,
    };
  },
});

export const signalful = declareWorkflow({
  workflowName: "signalful",
  contract: childWireContract,
  implementation: async (context) => {
    let noteText: string | null = null;
    let finished = false;

    context.handleSignal("note", (signalArgs) => {
      noteText = signalArgs.text;
    });
    context.handleSignal("finish", () => {
      finished = true;
    });

    await condition(() => finished);

    return { noteText };
  },
});

export const parentSignal = declareWorkflow({
  workflowName: "parentSignal",
  contract: childWireContract,
  implementation: async (context, args) => {
    const requestedChildWorkflowId = `${context.info.workflowId}-child`;
    const handleResult = await context.startChildWorkflow(childWireContract, "signalful", {
      workflowId: requestedChildWorkflowId,
      args: {},
    });
    if (handleResult.isDefect()) {
      return { status: describeDefect(handleResult.cause), sendError: null, noteText: null };
    }
    if (handleResult.isErr()) {
      return { status: `err:${handleResult.error._tag}`, sendError: null, noteText: null };
    }
    const handle = handleResult.value;

    let sendError: string | null = null;
    if (args.mode === "valid") {
      const sent = await handle.signals.note({ text: "hi" });
      if (sent.isDefect()) {
        return { status: describeDefect(sent.cause), sendError: null, noteText: null };
      }
      if (sent.isErr()) {
        return { status: `err:${sent.error._tag}`, sendError: null, noteText: null };
      }
    } else {
      // `text: 42` violates `signalful`'s "note" input schema (`z.string()`
      // pre-transform). `createTypedChildSignals` validates BEFORE sending,
      // so this must fail client-side without ever reaching the child.
      const sent = await handle.signals.note({ text: 42 } as never);
      if (sent.isErr()) sendError = sent.error.message;
    }

    const finishSent = await handle.signals.finish(undefined);
    if (finishSent.isDefect()) {
      return { status: describeDefect(finishSent.cause), sendError, noteText: null };
    }
    if (finishSent.isErr()) {
      return { status: `err:${finishSent.error._tag}`, sendError, noteText: null };
    }

    const childResult = await handle.result();
    if (childResult.isDefect()) {
      return { status: describeDefect(childResult.cause), sendError, noteText: null };
    }
    if (childResult.isErr()) {
      return { status: `err:${childResult.error._tag}`, sendError, noteText: null };
    }

    return {
      status: "ok",
      sendError,
      noteText: childResult.value.noteText,
      // `handle.workflowId`, not the locally computed `childWorkflowId` used
      // to START the child — see `parentChild`'s identical rationale above.
      childWorkflowId: handle.workflowId,
    };
  },
});
