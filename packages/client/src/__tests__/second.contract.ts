import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

/**
 * Second test contract on its own task queue — exercised by the
 * "multiple contracts, one root" integration case: one `TypedClient`
 * root drives both this contract and `testContract`, each routed to
 * its own queue via `root.for(contract)`.
 */
export const secondContract = defineContract({
  taskQueue: "second-client-queue",
  workflows: {
    echoWorkflow: defineWorkflow({
      input: z.object({
        text: z.string(),
      }),
      output: z.object({
        echoed: z.string(),
      }),
      startPolicy: "allow-duplicate",
    }),
  },
});
