import { declareWorkflow } from "../workflow.js";
import { registrationContract } from "./registration.contract.js";

/** `beta` is declared on the contract but never `declareWorkflow`-exported. */

export const alpha = declareWorkflow({
  workflowName: "alpha",
  contract: registrationContract,
  implementation: async (_context, args) => ({ result: args.value }),
});
