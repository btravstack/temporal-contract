import { ContractError, declareWorkflow } from "../workflow.js";
import { retryContract } from "./retry.contract.js";

export const runsFlaky = declareWorkflow({
  workflowName: "runsFlaky",
  contract: retryContract,
  implementation: async (context, args) => {
    const result = await context.activities.flaky({ mode: args.mode });

    // Fold the failure into a returned status rather than rethrowing: a
    // rethrown defect becomes a Workflow-Task retry loop that time-skipping
    // cannot fast-forward past, turning a regression into a 120s hang.
    if (result.isDefect()) return { outcome: `defect:${String(result.cause)}`, attempts: -1 };
    if (result.isErr()) {
      const error = result.error;
      if (error instanceof ContractError) {
        // `data.at` carries the attempt number the activity failed on.
        const at = (error.data as { at: number }).at;
        return { outcome: `err:${error.errorName}`, attempts: at };
      }
      return { outcome: `err:${error.name}`, attempts: -1 };
    }
    return { outcome: "ok", attempts: result.value.attempts };
  },
});
