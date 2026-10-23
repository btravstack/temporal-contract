import { declareWorkflow, propagateFailure } from "../workflow.js";
import { bindingContract } from "./binding.contract.js";

export const run = declareWorkflow({
  contract: bindingContract,
  workflowName: "run",
  implementation: (context) => propagateFailure(context.activities.identify({})),
});
