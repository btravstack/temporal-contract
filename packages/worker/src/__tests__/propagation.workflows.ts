import { ActivityFailure } from "@temporalio/workflow";

import { declareWorkflow } from "../workflow.js";
import { propagationContract } from "./propagation.contract.js";

/**
 * Awaits the activity without catching. Today `alwaysFailsNoErrors` has no
 * declared errors, so this is a plain `Promise` that throws Temporal's
 * `ActivityFailure`, and Temporal fails the workflow.
 *
 * After the uniform-`AsyncResult` change this body becomes
 * `await propagateActivityFailure(context.activities.alwaysFailsNoErrors({}))`
 * and the observable outcome must be IDENTICAL.
 */
export const propagatesFailure = declareWorkflow({
  workflowName: "propagatesFailure",
  contract: propagationContract,
  implementation: async (context) => {
    await context.activities.alwaysFailsNoErrors({});
    return { reached: true };
  },
});

/**
 * Catches the failure so the workflow COMPLETES. Uses try/catch because today
 * the call throws; after the change this becomes an `isErr()` narrow.
 */
export const handlesFailure = declareWorkflow({
  workflowName: "handlesFailure",
  contract: propagationContract,
  implementation: async (context) => {
    try {
      await context.activities.alwaysFailsNoErrors({});
      return { outcome: "unexpected-success" };
    } catch (error) {
      // Fold the caught error's identity into the returned status rather
      // than a bare `catch { return { outcome: "handled" } }`: a bare catch
      // swallows ANYTHING (an input-validation failure at the proxy
      // boundary, a proxy-construction error), so a regression that never
      // even dispatched the activity would still report "handled". Naming
      // `ActivityFailure` — Temporal's own wrapper for the call under test —
      // pins WHAT was caught, not just that something was.
      const errorName = error instanceof ActivityFailure ? error.name : "unknown";
      return { outcome: `handled:${errorName}` };
    }
  },
});
