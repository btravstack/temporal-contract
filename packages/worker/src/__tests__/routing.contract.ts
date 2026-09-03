import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

// Contract for the `activityOptionsByName` task-queue routing spec
// (`routing.spec.ts`).

/** Task queue the dedicated activity worker polls (the routing target). */
export const ROUTED_ACTIVITY_QUEUE = "routing-activity-q";

const reportQueue = defineActivity({
  input: z.object({}),
  output: z.object({ handledBy: z.string() }),
  activityOptions: { startToCloseTimeout: "10 seconds", retry: { maximumAttempts: 3 } },
});

const routedFlow = defineWorkflow({
  input: z.object({}),
  output: z.object({ handledBy: z.string() }),
  startPolicy: "allow-duplicate",
  activities: { reportQueue },
});

export const routingContract = defineContract({
  taskQueue: "routing-workflow-q",
  workflows: { routedFlow },
});
