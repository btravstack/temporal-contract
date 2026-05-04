import { describe, expect, vi, beforeEach } from "vitest";
import { Worker } from "@temporalio/worker";
import { TypedClient } from "../client.js";
import { it as baseIt } from "@temporal-contract/testing/extension";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { testContract } from "./test.contract.js";
import { Client } from "@temporalio/client";

// ============================================================================
// Test Setup
// ============================================================================

const it = baseIt.extend<{
  worker: Worker;
  client: TypedClient<typeof testContract>;
}>({
  worker: [
    async ({ workerConnection }, use) => {
      // Create and start worker
      const worker = await Worker.create({
        connection: workerConnection,
        namespace: "default",
        taskQueue: testContract.taskQueue,
        workflowsPath: workflowPath("test.workflows"),
        activities: {
          // Global activities
          logMessage: async ({ message }: { message: string }) => {
            logMessages.push(message);
            return {};
          },
          // Workflow-specific activities
          processMessage: async ({ message }: { message: string }) => {
            return {
              processed: message.toUpperCase(),
            };
          },
        },
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

// ============================================================================
// Integration Tests
// ============================================================================

describe("Client Package - Integration Tests", () => {
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
        expect(result.value).toEqual({ result: "Processed: test-data" });
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
        expect(result.value).toEqual({ result: "Processed: async-test" });
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
        expect(result.value).toEqual({ result: "Processed: get-handle-test" });
      }
    });
  });

  describe("Workflow with Activities", () => {
    it("should execute workflow with activity", async ({ client }) => {
      // GIVEN
      const input = { message: "hello world" };

      // WHEN
      const result = await client.executeWorkflow("workflowWithActivity", {
        workflowId: `activity-${Date.now()}`,
        args: input,
      });

      // THEN
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({ result: "HELLO WORLD" });
      }
      expect(logMessages).toEqual(expect.arrayContaining(["Activity result: HELLO WORLD"]));
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
        args: invalidInput as { value: string },
      });

      expect(execution.isErr()).toBe(true);
      if (execution.isErr()) {
        expect(execution.error).toEqual(
          expect.objectContaining({ name: "WorkflowValidationError" }),
        );
      }
    });

    it("should validate workflow output", async ({ client }) => {
      // GIVEN - Valid workflow input
      const input = { message: "test" };

      // WHEN
      const result = await client.executeWorkflow("workflowWithActivity", {
        workflowId: `validate-output-${Date.now()}`,
        args: input,
      });

      // THEN - Should succeed with proper validation
      expect(result.isOk()).toBe(true);
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
        expect(result.value).toEqual({ finalValue: 18 }); // 10 + 5 + 3
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
        expect(queryResult.value).toEqual({ value: 42 });
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
        expect(updateResult.value).toEqual({ newValue: 15 }); // 5 * 3
      }

      // Workflow should complete with the multiplied value
      const result = await handle.result();
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({ finalValue: 15 });
      }
    });
  });

  describe("Workflow Handle Operations", () => {
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
          expect.objectContaining({ workflowId, type: "simpleWorkflow" }),
        );
      }

      // Wait for workflow to complete
      await handle.result();
    });

    it("should cancel a running workflow", async ({ client }) => {
      // GIVEN
      const workflowId = `cancel-test-${Date.now()}`;
      const handleResult = await client.startWorkflow("interactiveWorkflow", {
        workflowId,
        args: { initialValue: 10 },
      });

      expect(handleResult.isOk()).toBe(true);
      if (!handleResult.isOk()) throw new Error("Expected Ok result");
      const handle = handleResult.value;

      // WHEN
      const cancelResult = await handle.cancel();

      // THEN
      expect(cancelResult.isOk()).toBe(true);

      // Result should throw or return error
      const result = await handle.result();
      expect(result.isErr()).toBe(true);
    });

    it("should terminate a running workflow", async ({ client }) => {
      // GIVEN
      const workflowId = `terminate-test-${Date.now()}`;
      const handleResult = await client.startWorkflow("interactiveWorkflow", {
        workflowId,
        args: { initialValue: 10 },
      });

      expect(handleResult.isOk()).toBe(true);
      if (!handleResult.isOk()) throw new Error("Expected Ok result");
      const handle = handleResult.value;

      // WHEN
      const terminateResult = await handle.terminate("Test termination");

      // THEN
      expect(terminateResult.isOk()).toBe(true);

      // Result should throw or return error
      const result = await handle.result();
      expect(result.isErr()).toBe(true);
    });
  });

  describe("Result Pattern", () => {
    it("should support Result.isOk() check", async ({ client }) => {
      // GIVEN
      const input = { value: "test" };

      // WHEN
      const result = await client.executeWorkflow("simpleWorkflow", {
        workflowId: `result-ok-${Date.now()}`,
        args: input,
      });

      // THEN
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({ result: "Processed: test" });
      }
    });

    it("should support Result.match() pattern", async ({ client }) => {
      // GIVEN
      const input = { value: "test" };

      // WHEN
      const result = await client.executeWorkflow("simpleWorkflow", {
        workflowId: `result-match-${Date.now()}`,
        args: input,
      });

      // THEN
      let matched = false;
      result.match(
        (value) => {
          matched = true;
          expect(value).toEqual({ result: "Processed: test" });
        },
        () => {
          throw new Error("Should not be called");
        },
      );
      expect(matched).toBe(true);
    });

    it("should support Result.map() transformation", async ({ client }) => {
      // GIVEN
      const input = { value: "test" };

      // WHEN
      const result = await client.executeWorkflow("simpleWorkflow", {
        workflowId: `result-map-${Date.now()}`,
        args: input,
      });

      // THEN
      const mapped = result.map((value) => value.result.toUpperCase());
      expect(mapped.isOk()).toBe(true);
      if (mapped.isOk()) {
        expect(mapped.value).toBe("PROCESSED: TEST");
      }
    });
  });
});

function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}
