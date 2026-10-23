import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

const identify = defineActivity({
  input: z.object({}),
  output: z.string(),
  activityOptions: { startToCloseTimeout: "10 seconds", retry: { maximumAttempts: 1 } },
});
const run = defineWorkflow({
  input: z.object({}),
  output: z.string(),
  startPolicy: "once-per-id",
  activities: { identify },
});
export const bindingContract = defineContract({
  taskQueue: "binding-protocol",
  workflows: { run },
});
