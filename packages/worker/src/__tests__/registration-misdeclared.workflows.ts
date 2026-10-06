import { declareWorkflow } from "../workflow.js";
import { registrationContract } from "./registration.contract.js";

/**
 * `declareWorkflow` throws `ContractMisuseError` at import: "gamma" is not on
 * the contract. Inside the sandbox that stalls every task, so
 * `TypedWorker.create` must fail instead of skipping the module.
 */
export const gamma = declareWorkflow({
  workflowName: "gamma" as never,
  contract: registrationContract,
  implementation: async () => ({}) as never,
});
