import { describe, expect, vi, beforeEach } from "vitest";
import { Worker } from "@temporalio/worker";
import { TypedClient, WorkflowValidationError } from "@temporal-contract/client";
import { it as baseIt } from "@temporal-contract/testing/extension";
import { okAsync, errAsync } from "neverthrow";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { testContract } from "./test.contract.js";
import { Client } from "@temporalio/client";
import { ApplicationFailure, declareActivitiesHandler } from "../activity.js";
import { createWorker } from "../worker.js";

// ============================================================================
// Test Setup
// ============================================================================

const it = baseIt.extend<{
  worker: Worker;
  client: TypedClient<typeof testContract>;
}>({
  worker: [
    async ({ workerConnection }, use) => {
      // Create and start worker using createWorker
      const worker = await createWorker({
        contract: testContract,
        connection: workerConnection,
        namespace: "default",
        workflowsPath: workflowPath("test.workflows"),
        activities,
      });

      // Start worker in background
      worker.run().catch((err) => {
        console.error("Worker failed:", err);
      });

      await vi.waitFor(() => worker.getState() === "RUNNING", { interval: 100 });

      await use(worker);

      await worker.shutdown();

      await vi.waitFor(() => worker.getState() === "STOPPED", { interval: 100 });
    },
    { auto: true },
  ],
  client: async ({ clientConnection }, use) => {
    // Create typed client
    const rawClient = new Client({
      connection: clientConnection,
      namespace: "default",
    });
    const client = TypedClient.create(testContract, rawClient);

    await use(client);
  },
});

// ============================================================================
// Mock implementations for activities
// ============================================================================

const logMessages: string[] = [];

const activities = declareActivitiesHandler({
  contract: testContract,
  activities: {
    simpleWorkflow: {},

    workflowWithActivities: {
      processPayment: ({ amount }) => {
        return okAsync({
          transactionId: `TXN-${amount}-${Date.now()}`,
          success: amount > 0,
        });
      },

      validateOrder: ({ orderId }) => {
        return okAsync({
          valid: orderId.startsWith("ORD-"),
        });
      },
    },

    interactiveWorkflow: {},

    parentWorkflow: {},

    childWorkflow: {},

    workflowWithFailableActivity: {},

    logMessage: ({ message }) => {
      logMessages.push(message);
      return okAsync({});
    },

    failableActivity: ({ shouldFail }) => {
      if (shouldFail) {
        return errAsync(
          ApplicationFailure.create({
            type: "ACTIVITY_FAILED",
            message: "Activity was configured to fail",
            details: [{ shouldFail: true }],
          }),
        );
      }
      return okAsync({ success: true });
    },
  },
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("Worker Package - Integration Tests", () => {
  beforeEach(() => {
    logMessages.length = 0;
  });

  describe("Basic Workflow Execution", () => {
    it("should execute a simple workflow successfully", async ({ client }) => {
      // GIVEN
      const input = { value: "test-data" };

      // WHEN
      const result = await client.executeWorkflow("simpleWorkflow", {
        workflowId: `simple-${Date.now()}`,
        args: input,
      });

      // THEN
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({
          result: "Processed: test-data",
        });
      }
      expect(logMessages).toContain("Processing: test-data");
    });

    it("should start workflow and get result separately", async ({ client }) => {
      // GIVEN
      const input = { value: "async-test" };
      const workflowId = `simple-async-${Date.now()}`;

      // WHEN
      const handleResult = await client.startWorkflow("simpleWorkflow", {
        workflowId,
        args: input,
      });

      // THEN
      expect(handleResult.isOk()).toBe(true);
      if (!handleResult.isOk()) throw new Error("Expected Ok result");

      const handle = handleResult.value;
      expect(handle.workflowId).toBe(workflowId);

      const result = await handle.result();
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({
          result: "Processed: async-test",
        });
      }
    });

    it("should retrieve workflow handle after start", async ({ client }) => {
      // GIVEN
      const input = { value: "get-handle-test" };
      const workflowId = `simple-handle-${Date.now()}`;

      await client.startWorkflow("simpleWorkflow", {
        workflowId,
        args: input,
      });

      // WHEN
      const handleResult = await client.getHandle("simpleWorkflow", workflowId);

      // THEN
      expect(handleResult.isOk()).toBe(true);
      if (!handleResult.isOk()) throw new Error("Expected Ok result");

      const handle = handleResult.value;
      const result = await handle.result();
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({
          result: "Processed: get-handle-test",
        });
      }
    });
  });

  describe("Workflow with Activities", () => {
    it("should execute workflow with workflow-specific activities", async ({ client }) => {
      // GIVEN
      const input = {
        orderId: "ORD-123",
        amount: 100,
      };

      // WHEN
      const result = await client.executeWorkflow("workflowWithActivities", {
        workflowId: `order-${Date.now()}`,
        args: input,
      });

      // THEN
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({
          orderId: "ORD-123",
          status: "success",
          transactionId: expect.stringContaining("TXN-100"),
        });
      }
      expect(logMessages).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Order ORD-123 completed with transaction TXN-100"),
        ]),
      );
    });

    it("should handle validation failure in workflow", async ({ client }) => {
      // GIVEN - Invalid order ID (doesn't start with ORD-)
      const input = {
        orderId: "INVALID-123",
        amount: 100,
      };

      // WHEN
      const result = await client.executeWorkflow("workflowWithActivities", {
        workflowId: `order-invalid-${Date.now()}`,
        args: input,
      });

      // THEN
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({
          orderId: "INVALID-123",
          status: "failed",
          reason: "Invalid order ID",
        });
      }
    });

    it("should handle payment failure in workflow", async ({ client }) => {
      // GIVEN - Amount is 0 which causes payment to fail
      const input = {
        orderId: "ORD-456",
        amount: 0,
      };

      // WHEN
      const result = await client.executeWorkflow("workflowWithActivities", {
        workflowId: `order-payment-fail-${Date.now()}`,
        args: input,
      });

      // THEN
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({
          orderId: "ORD-456",
          status: "failed",
          reason: "Payment failed",
        });
      }
    });
  });

  describe("Input/Output Validation", () => {
    it("should validate workflow input and reject invalid data", async ({ client }) => {
      // GIVEN - Invalid input (missing required field)
      const invalidInput = {
        // missing 'value' field
      };

      // WHEN/THEN - Use type assertion to bypass compile-time check for runtime validation test
      const execution = await client.executeWorkflow("simpleWorkflow", {
        workflowId: `invalid-input-${Date.now()}`,
        // @ts-expect-error Testing invalid input
        args: invalidInput,
      });

      expect(execution.isErr()).toBe(true);
      if (execution.isErr()) {
        expect(execution.error).toBeInstanceOf(WorkflowValidationError);
      }
    });

    it("should validate activity input", async ({ client }) => {
      // This test verifies that activity input validation happens at runtime
      // by using a workflow that calls activities with the data passed to it

      // GIVEN - Valid workflow input that will be passed to activities
      const input = {
        orderId: "ORD-789",
        amount: 50,
      };

      // WHEN
      const result = await client.executeWorkflow("workflowWithActivities", {
        workflowId: `validate-activity-${Date.now()}`,
        args: input,
      });

      // THEN - Should succeed with proper validation
      expect(result.isOk()).toBe(true);
    });
  });

  describe("Child Workflows", () => {
    it("should execute child workflows from parent", async ({ client }) => {
      // GIVEN
      const input = { count: 3 };

      // WHEN
      const result = await client.executeWorkflow("parentWorkflow", {
        workflowId: `parent-${Date.now()}`,
        args: input,
      });

      // THEN
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({
          results: ["Child 0 completed", "Child 1 completed", "Child 2 completed"],
        });
      }

      // Check that child workflows logged
      expect(logMessages).toEqual(
        expect.arrayContaining([
          "Child workflow 0 running",
          "Child workflow 1 running",
          "Child workflow 2 running",
        ]),
      );
    });
  });

  describe("Signals, Queries, and Updates", () => {
    it("should send signal to workflow and modify state", async ({ client }) => {
      // GIVEN
      const workflowId = `signal-test-${Date.now()}`;
      const handleResult = await client.startWorkflow("interactiveWorkflow", {
        workflowId,
        args: { initialValue: 10 },
      });

      expect(handleResult.isOk()).toBe(true);
      if (!handleResult.isOk()) throw new Error("Expected Ok result");
      const handle = handleResult.value;

      // WHEN - Send signals to increment value
      await handle.signals.increment({ amount: 5 });
      await handle.signals.increment({ amount: 3 });

      // THEN - Workflow should complete with updated value
      const result = await handle.result();
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({
          finalValue: 18, // 10 + 5 + 3
        });
      }
    });

    it("should query workflow state", async ({ client }) => {
      // GIVEN - Start workflow with sleep to allow time for query
      const workflowId = `query-test-${Date.now()}`;
      const handleResult = await client.startWorkflow("interactiveWorkflow", {
        workflowId,
        args: { initialValue: 42 },
      });

      expect(handleResult.isOk()).toBe(true);
      if (!handleResult.isOk()) throw new Error("Expected Ok result");
      const handle = handleResult.value;

      // WHEN - Query the current value
      const queryResult = await handle.queries.getCurrentValue({});

      // THEN - Should return current value
      expect(queryResult.isOk()).toBe(true);
      if (queryResult.isOk()) {
        expect(queryResult.value).toEqual({
          value: 42,
        });
      }

      // Wait for workflow to complete
      await handle.result();
    });

    it("should send update to workflow and get returned value", async ({ client }) => {
      // GIVEN
      const workflowId = `update-test-${Date.now()}`;
      const handleResult = await client.startWorkflow("interactiveWorkflow", {
        workflowId,
        args: { initialValue: 5 },
      });

      expect(handleResult.isOk()).toBe(true);
      if (!handleResult.isOk()) throw new Error("Expected Ok result");
      const handle = handleResult.value;

      // WHEN - Send update to multiply value
      const updateResult = await handle.updates.multiply({ factor: 3 });

      // THEN - Update should return the new value
      expect(updateResult.isOk()).toBe(true);
      if (updateResult.isOk()) {
        expect(updateResult.value).toEqual({
          newValue: 15, // 5 * 3
        });
      }

      // Workflow should complete with the multiplied value
      const result = await handle.result();
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({
          finalValue: 15,
        });
      }
    });
  });

  describe("Workflow Description", () => {
    it("should describe a running workflow", async ({ client }) => {
      // GIVEN
      const workflowId = `describe-test-${Date.now()}`;
      const handleResult = await client.startWorkflow("simpleWorkflow", {
        workflowId,
        args: { value: "describe-me" },
      });

      expect(handleResult.isOk()).toBe(true);
      if (!handleResult.isOk()) throw new Error("Expected Ok result");
      const handle = handleResult.value;

      // WHEN
      const describeResult = await handle.describe();

      // THEN
      expect(describeResult.isOk()).toBe(true);
      if (describeResult.isOk()) {
        expect(describeResult.value).toEqual(
          expect.objectContaining({
            workflowId,
            type: "simpleWorkflow",
          }),
        );
      }

      // Wait for workflow to complete
      await handle.result();
    });
  });

  describe.skip("Error Handling", () => {
    it("should propagate ApplicationFailure from activity to workflow", async ({ client }) => {
      // GIVEN
      const input = { shouldFail: true };

      // WHEN
      const result = await client.executeWorkflow("workflowWithFailableActivity", {
        workflowId: `error-handling-${Date.now()}`,
        args: input,
      });

      // THEN — at the workflow boundary Temporal wraps the activity's
      // ApplicationFailure in an ActivityFailure (cause is the original
      // ApplicationFailure with the type/message/details preserved).
      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("Expected error result");
      const error = result.error;
      expect(error.message).toMatch(/failableActivity failed/);
      // Inner cause carries the ApplicationFailure from the activity.
      expect((error as { cause?: unknown }).cause).toBeInstanceOf(ApplicationFailure);
    });
  });
});

function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}
