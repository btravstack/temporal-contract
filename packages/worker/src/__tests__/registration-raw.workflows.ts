import { declareWorkflow } from "../workflow.js";
import { registrationContract } from "./registration.contract.js";

/**
 * `alpha` uses `declareWorkflow`; `beta` is a raw
 * `@temporalio/workflow`-style function exported under its contract name —
 * a supported pattern the registration check must accept (Temporal
 * registers by export name, so it registers correctly).
 */

export const alpha = declareWorkflow({
  workflowName: "alpha",
  contract: registrationContract,
  implementation: async (_context, args) => ({ result: args.value }),
});

export async function beta(args: { n: number }): Promise<{ doubled: number }> {
  return { doubled: args.n * 2 };
}
