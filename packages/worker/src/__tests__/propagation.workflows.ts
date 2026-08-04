import { ActivityFailure } from "@temporalio/workflow";

import { ActivityError } from "../errors.js";
import { declareWorkflow, propagateActivityFailure } from "../workflow.js";
import { propagationContract } from "./propagation.contract.js";

/**
 * Lets the failure escape via `propagateActivityFailure`, the post-change
 * equivalent of the bare `await` this fixture used before. The
 * characterization spec asserts the workflow still FAILS and that Temporal
 * still retried the activity to its configured maximum.
 */
export const propagatesFailure = declareWorkflow({
  workflowName: "propagatesFailure",
  contract: propagationContract,
  implementation: async (context) => {
    await propagateActivityFailure(context.activities.alwaysFailsNoErrors({}));
    return { reached: true };
  },
});

/**
 * Catches the failure by narrowing, so the workflow COMPLETES. Uses
 * `isErr()`/`isDefect()` because the call now returns an `AsyncResult`; before
 * the uniform-`AsyncResult` change this was a bare try/catch.
 */
export const handlesFailure = declareWorkflow({
  workflowName: "handlesFailure",
  contract: propagationContract,
  implementation: async (context) => {
    const result = await context.activities.alwaysFailsNoErrors({});

    if (result.isOk()) {
      return { outcome: "unexpected-success" };
    }

    // Fold the caught error's identity into the returned status rather than
    // a bare "handled": a bare success-path swallows ANYTHING (an
    // input-validation failure at the proxy boundary, a proxy-construction
    // error), so a regression that never even dispatched the activity would
    // still report "handled". Naming `ActivityFailure` — Temporal's own
    // wrapper for the call under test, retained pre-unwrap as
    // `ActivityError.originalFailure` — pins WHAT was caught, not just that
    // something was.
    const error: unknown = result.isErr() ? result.error : result.cause;
    const originalFailure = error instanceof ActivityError ? error.originalFailure : undefined;
    const errorName = originalFailure instanceof ActivityFailure ? originalFailure.name : "unknown";
    return { outcome: `handled:${errorName}` };
  },
});
