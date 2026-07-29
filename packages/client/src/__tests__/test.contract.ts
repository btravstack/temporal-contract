import {
  defineActivity,
  defineContract,
  defineQuery,
  defineSignal,
  defineUpdate,
  defineWorkflow,
} from "@temporal-contract/contract";
import { z } from "zod";

/**
 * Test contract for client integration tests
 * This contract exercises various client features
 */
export const testContract = defineContract({
  taskQueue: "test-client-queue",
  workflows: {
    // Simple workflow for basic testing
    simpleWorkflow: defineWorkflow({
      input: z.object({
        value: z.string(),
      }),
      output: z.object({
        result: z.string(),
      }),
    }),

    // Workflow with signals, queries, and updates
    interactiveWorkflow: defineWorkflow({
      input: z.object({
        initialValue: z.number(),
      }),
      output: z.object({
        finalValue: z.number(),
      }),
      signals: {
        increment: defineSignal({
          input: z.object({
            amount: z.number(),
          }),
        }),
      },
      queries: {
        getCurrentValue: defineQuery({
          input: z.object({}),
          output: z.object({
            value: z.number(),
          }),
        }),
      },
      updates: {
        multiply: defineUpdate({
          input: z.object({
            factor: z.number(),
          }),
          output: z.object({
            newValue: z.number(),
          }),
        }),
      },
    }),

    // Workflow with transforming input/output schemas — exercises the D1
    // wire format: the sender validates but transmits the ORIGINAL value;
    // the receiver parses, so each transform applies exactly once.
    transformWorkflow: defineWorkflow({
      input: z.object({
        text: z.string().transform((s) => `${s}!`),
      }),
      output: z.object({
        // What the (receive-side-parsed) input looked like to the handler.
        handlerSaw: z.string(),
        // The handler returns the pre-transform number; only the client's
        // receive-side parse doubles it.
        doubled: z.number().transform((n) => n * 2),
      }),
    }),

    // Workflow with activities
    workflowWithActivity: defineWorkflow({
      input: z.object({
        message: z.string(),
      }),
      output: z.object({
        result: z.string(),
      }),
      activities: {
        processMessage: defineActivity({
          input: z.object({
            message: z.string(),
          }),
          output: z.object({
            processed: z.string(),
          }),
        }),
      },
    }),
  },
  activities: {
    // Global activity available to all workflows
    logMessage: defineActivity({
      input: z.object({
        message: z.string(),
      }),
      output: z.object({}),
    }),
  },
});
