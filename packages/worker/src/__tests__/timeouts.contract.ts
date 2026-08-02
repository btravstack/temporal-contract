import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

/**
 * The activity reports back the timeouts Temporal actually materialized for
 * its task, so each layer of the merge is proven by effect rather than by
 * inspecting the options we passed in.
 *
 * `heartbeatTimeout` is the one this repo asserted nowhere before — a lost
 * heartbeat timeout means a dead activity is never retried.
 */
const reportsTimeouts = defineActivity({
  input: z.object({}),
  output: z.object({
    startToCloseMs: z.number(),
    scheduleToCloseMs: z.number(),
    heartbeatMs: z.number(),
  }),
  // Contract layer: heartbeat declared here and nowhere else.
  activityOptions: {
    heartbeatTimeout: "7 seconds",
    retry: { maximumAttempts: 1 },
  },
});

const reportsLayered = defineWorkflow({
  input: z.object({}),
  output: z.object({
    startToCloseMs: z.number(),
    scheduleToCloseMs: z.number(),
    heartbeatMs: z.number(),
  }),
  activities: { reportsTimeouts },
});

export const timeoutsContract = defineContract({
  taskQueue: "timeouts-tests",
  workflows: { reportsLayered },
});
