import { condition } from "@temporalio/workflow";

import { declareWorkflow } from "../workflow.js";
import { handlersContract } from "./handlers.contract.js";

export const counter = declareWorkflow({
  workflowName: "counter",
  contract: handlersContract,
  implementation: async (context) => {
    let total = 0;
    let finished = false;

    context.handleSignal("bump", ({ by }) => {
      total += by;
      // 10 is the agreed terminal value for these tests.
      if (total >= 10) finished = true;
    });

    context.handleQuery("peek", () => ({ total }));
    context.handleQuery("describe", (label) => ({ label, total }));

    context.handleUpdate("applyDelta", async ({ delta }) => {
      total += delta;
      return { total };
    });

    await condition(() => finished);

    return { total };
  },
});

/**
 * Exists solely to prove behavior 7: an async-validating query input schema
 * trips `ContractMisuseError` at bind time (`context.handleQuery`, called
 * synchronously on the workflow's first Workflow Task), not on the first
 * live query. The `await condition(() => false)` below is never reached —
 * the bind throws first — but keeps the function's return type honest.
 */
export const bindsAsyncQuerySchema = declareWorkflow({
  workflowName: "bindsAsyncQuerySchema",
  contract: handlersContract,
  implementation: async (context) => {
    context.handleQuery("asyncCheckedQuery", () => ({ ok: true }));
    await condition(() => false);
    return {};
  },
});
