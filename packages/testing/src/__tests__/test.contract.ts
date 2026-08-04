import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

// Minimal inline contract for exercising the contract-aware fixtures:
// one workflow with one activity.

const decorate = defineActivity({
  input: z.object({ name: z.string() }),
  output: z.object({ decorated: z.string() }),
  activityOptions: { startToCloseTimeout: "10 seconds" },
});

const greet = defineWorkflow({
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
  idempotency: "allow-duplicate",
  activities: { decorate },
});

export const testContract = defineContract({
  taskQueue: "testing-contract-fixtures",
  workflows: { greet },
});
