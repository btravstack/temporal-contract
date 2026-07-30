import { declareWorkflow } from "../workflow.js";
import { registrationContract } from "./registration.contract.js";

/** Every contract workflow exported under its declared name — the happy path. */

export const alpha = declareWorkflow({
  workflowName: "alpha",
  contract: registrationContract,
  implementation: async (_context, args) => ({ result: args.value }),
});

export const beta = declareWorkflow({
  workflowName: "beta",
  contract: registrationContract,
  implementation: async (_context, args) => ({ doubled: args.n * 2 }),
});
