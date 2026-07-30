import { declareWorkflow } from "../workflow.js";
import { registrationContract } from "./registration.contract.js";

/**
 * `alpha` is declared correctly but exported under a different name —
 * Temporal registers workflows by EXPORT name, so this would register the
 * workflow as type "renamedAlpha" and leave "alpha" unregistered.
 */

export const renamedAlpha = declareWorkflow({
  workflowName: "alpha",
  contract: registrationContract,
  implementation: async (_context, args) => ({ result: args.value }),
});

export const beta = declareWorkflow({
  workflowName: "beta",
  contract: registrationContract,
  implementation: async (_context, args) => ({ doubled: args.n * 2 }),
});
