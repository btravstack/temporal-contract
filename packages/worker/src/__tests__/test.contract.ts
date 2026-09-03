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
 * Test contract for integration tests
 * This contract exercises various worker features
 */
export const testContract = defineContract({
  taskQueue: "test-worker-queue",
  workflows: {
    // Simple workflow for basic testing
    simpleWorkflow: defineWorkflow({
      input: z.object({
        value: z.string(),
      }),
      output: z.object({
        result: z.string(),
      }),
      startPolicy: "allow-duplicate",
    }),

    // Workflow with its own activities
    workflowWithActivities: defineWorkflow({
      input: z.object({
        orderId: z.string(),
        amount: z.number(),
      }),
      output: z.object({
        orderId: z.string(),
        status: z.enum(["success", "failed"]),
        transactionId: z.string().optional(),
        reason: z.string().optional(),
      }),
      startPolicy: "allow-duplicate",
      activities: {
        processPayment: defineActivity({
          input: z.object({
            amount: z.number(),
          }),
          output: z.object({
            transactionId: z.string(),
            success: z.boolean(),
          }),
        }),
        validateOrder: defineActivity({
          input: z.object({
            orderId: z.string(),
          }),
          output: z.object({
            valid: z.boolean(),
          }),
          // Total bound shared by every worker; per-attempt bound still comes
          // from the workflow-wide `activityOptions`.
          activityOptions: {
            retry: { maximumAttempts: 3 },
          },
        }),
      },
    }),

    // Workflow with signals, queries, and updates
    interactiveWorkflow: defineWorkflow({
      input: z.object({
        initialValue: z.number(),
      }),
      output: z.object({
        finalValue: z.number(),
      }),
      startPolicy: "allow-duplicate",
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

    // Parent workflow that starts child workflows
    parentWorkflow: defineWorkflow({
      input: z.object({
        count: z.number(),
      }),
      output: z.object({
        results: z.array(z.string()),
      }),
      startPolicy: "allow-duplicate",
    }),

    // Child workflow to be called from parent
    childWorkflow: defineWorkflow({
      input: z.object({
        id: z.number(),
      }),
      output: z.object({
        message: z.string(),
      }),
      startPolicy: "allow-duplicate",
    }),

    // Workflow that calls a failable activity for error handling tests
    workflowWithFailableActivity: defineWorkflow({
      input: z.object({
        shouldFail: z.boolean(),
      }),
      output: z.object({
        success: z.boolean(),
      }),
      startPolicy: "allow-duplicate",
    }),
  },
  activities: {
    // Global activity available to all workflows
    logMessage: defineActivity({
      input: z.object({
        message: z.string(),
      }),
      output: z.object({}),
      // Total bound shared by every worker; per-attempt bound still comes
      // from each workflow's `activityOptions`.
      activityOptions: {
        retry: { maximumAttempts: 3 },
      },
    }),

    // Activity that can fail
    failableActivity: defineActivity({
      input: z.object({
        shouldFail: z.boolean(),
      }),
      output: z.object({
        success: z.boolean(),
      }),
      // Total bound shared by every worker; per-attempt bound still comes
      // from each workflow's `activityOptions`.
      activityOptions: {
        retry: { maximumAttempts: 3 },
      },
    }),
  },
});
