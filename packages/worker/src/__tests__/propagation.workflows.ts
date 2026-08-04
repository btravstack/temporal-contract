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
    } catch {
      return { outcome: "handled" };
    }
  },
});
