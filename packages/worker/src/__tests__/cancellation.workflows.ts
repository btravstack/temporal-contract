import { CancelledFailure } from "@temporalio/workflow";

import {
  ActivityCancelledError,
  declareWorkflow,
  rethrowCancellation,
  WorkflowCancelledError,
} from "../workflow.js";
import { cancellationContract } from "./cancellation.contract.js";

/**
 * Test-only defect formatter. Production workflow code should still rethrow
 * a defect's cause at the edge (the project-wide idiom — see
 * `rethrowCancellation`'s own doc comment and every OTHER `declareWorkflow`
 * in this test suite) so Temporal fails the Workflow Task on a genuine bug.
 * Every workflow in THIS file deliberately does not: a `throw` here turns
 * an unmodeled failure into an unbounded Workflow-Task-failure retry loop
 * (Temporal keeps retrying the same task), which would hang a test to its
 * execution timeout instead of failing an assertion the moment a regression
 * produces an unexpected defect. Folding the cause's message into a
 * terminal, assertable status keeps every execution here bounded AND keeps
 * the cause's content inspectable from the test (see `cancellable-defect`/
 * `noncancellable-defect` below, which assert the exact folded message).
 */
function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function describeDefect(cause: unknown): string {
  return `defect:${causeMessage(cause)}`;
}

export const swallowsCancellation = declareWorkflow({
  workflowName: "swallowsCancellation",
  contract: cancellationContract,
  // No `activityOptions`: `slowActivity` carries contract-level options.
  implementation: async (context) => {
    const result = await context.activities.slowActivity({ sleepMs: 5_000 });

    if (result.isDefect()) {
      // See `describeDefect` above for why this returns instead of
      // rethrowing at the edge.
      return { status: describeDefect(result.cause) };
    }
    if (result.isErr()) {
      // THE HAZARD: a generic "map every Err to a fallback" handler. It does
      // not distinguish `ActivityCancelledError` from any other declared
      // failure, so a real cancellation request is silently absorbed here —
      // the execution completes normally (status "handled:...") instead of
      // ending `Cancelled`.
      return { status: `handled:${result.error._tag}` };
    }

    return { status: "completed" };
  },
});

export const honorsCancellation = declareWorkflow({
  workflowName: "honorsCancellation",
  contract: cancellationContract,
  implementation: async (context) => {
    const result = await context.activities.slowActivity({ sleepMs: 5_000 });

    if (result.isDefect()) {
      return { status: describeDefect(result.cause) };
    }
    if (result.isErr()) {
      if (result.error instanceof ActivityCancelledError) {
        // THE FIX: recognize cancellation specifically and re-raise it, so
        // Temporal records the execution as `Cancelled` instead of letting a
        // generic handler absorb it into a normal completion.
        rethrowCancellation(result.error);
      }
      return { status: `handled:${result.error._tag}` };
    }

    return { status: "completed" };
  },
});

export const nonCancellableWorkflow = declareWorkflow({
  workflowName: "nonCancellableWorkflow",
  contract: cancellationContract,
  implementation: async (context) => {
    // An outer cancel request must be ignored for the scope's duration — the
    // activity call inside must run to completion regardless.
    const scoped = await context.nonCancellableScope(async () => {
      const result = await context.activities.slowActivity({ sleepMs: 2_000 });
      if (result.isDefect()) {
        return { status: describeDefect(result.cause) };
      }
      if (result.isErr()) {
        return { status: `activity-err:${result.error._tag}` };
      }
      return { status: "completed" };
    });

    if (scoped.isDefect()) {
      return { status: describeDefect(scoped.cause) };
    }
    if (scoped.isErr()) {
      // Cancellation raised from INSIDE the scope (not the outer cancel,
      // which `nonCancellableScope` ignores) — an internal cancel still ends
      // the execution `Cancelled`.
      rethrowCancellation(scoped.error);
    }

    return scoped.value;
  },
});

/**
 * Direct coverage of `cancellableScope`/`nonCancellableScope`'s own
 * Result-folding — no activity, no real time, resolves within a single
 * Workflow Task. Deliberately does NOT `rethrowCancellation`/rethrow a
 * defect's cause anywhere below (see `describeDefect` above): the point of
 * every mode here is to observe the classification itself (a controlled
 * probe), not to reproduce the "rethrow at the edge" production idiom, so
 * returning a status string keeps every execution terminal instead of
 * risking a Workflow Task failure retry loop on a regression.
 */
export const scopeMechanics = declareWorkflow({
  workflowName: "scopeMechanics",
  contract: cancellationContract,
  implementation: async (context, args) => {
    switch (args.mode) {
      case "cancellable-ok": {
        // Plain (non-`async`) callback returning a bare value — proves
        // `cancellableScope` accepts a genuinely synchronous callback (no
        // Promise involved) AND resolves it to `Ok(...)`.
        const result = await context.cancellableScope(() => "resolved");
        if (result.isDefect()) {
          return { outcome: describeDefect(result.cause) };
        }
        return { outcome: result.isErr() ? `err:${result.error._tag}` : `ok:${result.value}` };
      }
      case "cancellable-defect": {
        // A non-cancellation throw is an *unmodeled* failure — it must ride
        // the defect channel, not fold into `Err(WorkflowCancelledError)`.
        // Folding the cause's own message into `outcome` (via
        // `describeDefect`) — instead of a bare "defect" literal — lets the
        // test assert the exact cause content, not just its channel.
        const result = await context.cancellableScope(() => {
          // oxlint-disable-next-line unthrown/no-throw -- deliberate probe: cancellableScope must classify this as a defect, not an Err
          throw new Error("cancellable-scope-bug");
        });
        return {
          outcome: result.isDefect() ? describeDefect(result.cause) : result.isErr() ? "err" : "ok",
        };
      }
      case "noncancellable-ok": {
        const result = await context.nonCancellableScope(() => 42);
        if (result.isDefect()) {
          return { outcome: describeDefect(result.cause) };
        }
        return {
          outcome: result.isErr() ? `err:${result.error._tag}` : `ok:${String(result.value)}`,
        };
      }
      case "noncancellable-defect": {
        const result = await context.nonCancellableScope(() => {
          // oxlint-disable-next-line unthrown/no-throw -- deliberate probe: nonCancellableScope must classify this as a defect, not an Err
          throw new Error("non-cancellable-scope-bug");
        });
        return {
          outcome: result.isDefect() ? describeDefect(result.cause) : result.isErr() ? "err" : "ok",
        };
      }
      case "noncancellable-internal-cancel": {
        // A REAL `CancelledFailure` (not a mock, not `isCancellation`
        // faked) raised from INSIDE the scope — distinct from the outer
        // workflow cancel, which `nonCancellableScope` ignores entirely.
        // Proves the scope still folds a genuinely-cancellation-shaped
        // failure into `Err(WorkflowCancelledError)` rather than treating
        // everything inside a non-cancellable scope as an ordinary defect.
        // The cause's own message is folded in too, proving the scope
        // preserves it (mirrors `WorkflowCancelledError.cause` — see the
        // spec's cause-preservation assertion for this mode).
        const result = await context.nonCancellableScope(() => {
          // oxlint-disable-next-line unthrown/no-throw -- deliberate probe: nonCancellableScope must classify a real CancelledFailure as Err(WorkflowCancelledError), not a defect
          throw new CancelledFailure("manufactured internal cancel");
        });
        return {
          outcome:
            result.isErr() && result.error instanceof WorkflowCancelledError
              ? `err:WorkflowCancelledError:${causeMessage(result.error.cause)}`
              : result.isDefect()
                ? describeDefect(result.cause)
                : "ok",
        };
      }
    }
  },
});
