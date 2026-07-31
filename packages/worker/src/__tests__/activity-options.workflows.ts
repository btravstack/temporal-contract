import { declareWorkflow } from "../workflow.js";
import { activityOptionsContract } from "./activity-options.contract.js";

export const runsActivity = declareWorkflow({
  workflowName: "runsActivity",
  contract: activityOptionsContract,
  // No `activityOptions` here — the contract-level options must be what
  // reaches Temporal. That is the property under test.
  implementation: async (context, args) => {
    const result = await context.activities.slowActivity({ sleepMs: args.sleepMs });

    if (result.isDefect()) throw result.cause;
    // No named contract errors are declared on `slowActivity` — the timeout
    // surfaces as the generic `ActivityError` wrapper, not a rehydrated
    // typed error, so `.name` (not a contract `.type`) is what's available.
    if (result.isErr()) return { outcome: `err:${result.error.name}` };
    return { outcome: "completed" };
  },
});
