import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { defineContract } from "@temporal-contract/contract";
import { TypedClient } from "./client.js";
import {
  QueryValidationError,
  RuntimeClientError,
  SignalValidationError,
  UpdateValidationError,
  WorkflowNotFoundError,
  WorkflowValidationError,
} from "./errors.js";
import { Client } from "@temporalio/client";

// Create mock workflow object
const createMockWorkflow = () => ({
  start: vi.fn(),
  execute: vi.fn(),
  getHandle: vi.fn(),
});

// Mock Temporal Client
const mockWorkflow = createMockWorkflow();

vi.mock("@temporalio/client", () => ({
  WorkflowHandle: vi.fn(),
}));

describe("TypedClient", () => {
  const testContract = defineContract({
    taskQueue: "test-queue",
    workflows: {
      testWorkflow: {
        input: z.object({ name: z.string(), value: z.number() }),
        output: z.object({ result: z.string() }),
        queries: {
          getStatus: {
            input: z.tuple([]),
            output: z.string(),
          },
        },
        signals: {
          updateProgress: {
            input: z.tuple([z.number()]),
          },
        },
        updates: {
          setConfig: {
            input: z.tuple([z.object({ value: z.string() })]),
            output: z.boolean(),
          },
        },
      },
      simpleWorkflow: {
        input: z.object({ message: z.string() }),
        output: z.string(),
      },
    },
  });

  let typedClient: TypedClient<typeof testContract>;

  beforeEach(() => {
    vi.clearAllMocks();
    const rawClient = { workflow: mockWorkflow } as unknown as Client;
    typedClient = TypedClient.create(testContract, rawClient);
  });

  describe("TypedClient.create", () => {
    it("should create a typed client instance", () => {
      expect(typedClient).toBeInstanceOf(TypedClient);
    });
  });

  describe("startWorkflow", () => {
    it("should start a workflow with valid input and return Ok result", async () => {
      const mockHandle = {
        workflowId: "test-123",
        result: vi.fn().mockResolvedValue({ result: "success" }),
        query: vi.fn(),
        signal: vi.fn(),
        executeUpdate: vi.fn(),
        terminate: vi.fn(),
        cancel: vi.fn(),
        describe: vi.fn(),
        fetchHistory: vi.fn(),
      };

      mockWorkflow.start.mockResolvedValue(mockHandle);

      const result = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(result).toEqual(
        expect.objectContaining({
          tag: "Ok",
          value: expect.objectContaining({
            workflowId: "test-123",
          }),
        }),
      );

      expect(mockWorkflow.start).toHaveBeenCalledWith("testWorkflow", {
        workflowId: "test-123",
        taskQueue: "test-queue",
        args: [{ name: "hello", value: 42 }],
      });
    });

    it("should return Error result for invalid input", async () => {
      const result = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: "not-a-number" as unknown as number },
      });

      expect(result).toEqual(
        expect.objectContaining({
          tag: "Error",
          error: expect.any(WorkflowValidationError),
        }),
      );
    });

    it("should return Error result for non-existent workflow", async () => {
      const result = await typedClient.startWorkflow(
        "nonExistentWorkflow" as unknown as "testWorkflow",
        {
          workflowId: "test-123",
          args: {} as unknown as { name: string; value: number },
        },
      );

      expect(result).toEqual(
        expect.objectContaining({
          tag: "Error",
          error: expect.any(WorkflowNotFoundError),
        }),
      );
    });
  });

  describe("executeWorkflow", () => {
    it("should execute a workflow with valid input and return Ok result", async () => {
      mockWorkflow.execute.mockResolvedValue({ result: "success" });

      const result = await typedClient.executeWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(result).toEqual(
        expect.objectContaining({
          tag: "Ok",
          value: { result: "success" },
        }),
      );

      expect(mockWorkflow.execute).toHaveBeenCalledWith("testWorkflow", {
        workflowId: "test-123",
        taskQueue: "test-queue",
        args: [{ name: "hello", value: 42 }],
      });
    });

    it("should return Error result for invalid output", async () => {
      mockWorkflow.execute.mockResolvedValue({ wrong: "output" });

      const result = await typedClient.executeWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(result).toEqual(
        expect.objectContaining({
          tag: "Error",
          error: expect.any(WorkflowValidationError),
        }),
      );
    });

    it("should return Error result when workflow execution throws", async () => {
      mockWorkflow.execute.mockRejectedValue(new Error("Workflow execution failed"));

      const result = await typedClient.executeWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(result).toEqual(expect.objectContaining({ tag: "Error" }));
    });
  });

  describe("getHandle", () => {
    it("should get a workflow handle and return Ok result", async () => {
      const mockHandle = {
        workflowId: "test-123",
        result: vi.fn().mockResolvedValue({ result: "success" }),
        query: vi.fn(),
        signal: vi.fn(),
        executeUpdate: vi.fn(),
        terminate: vi.fn(),
        cancel: vi.fn(),
        describe: vi.fn(),
        fetchHistory: vi.fn(),
      };

      mockWorkflow.getHandle.mockReturnValue(mockHandle);

      const result = await typedClient.getHandle("testWorkflow", "test-123");

      expect(result).toEqual(
        expect.objectContaining({
          tag: "Ok",
          value: expect.objectContaining({ workflowId: "test-123" }),
        }),
      );
    });

    it("should return Error result for non-existent workflow", async () => {
      const result = await typedClient.getHandle(
        "nonExistentWorkflow" as unknown as "testWorkflow",
        "test-123",
      );

      expect(result).toEqual(
        expect.objectContaining({
          tag: "Error",
          error: expect.any(WorkflowNotFoundError),
        }),
      );
    });
  });

  describe("TypedWorkflowHandle", () => {
    type MockHandle = {
      workflowId: string;
      result: ReturnType<typeof vi.fn>;
      query: ReturnType<typeof vi.fn>;
      signal: ReturnType<typeof vi.fn>;
      executeUpdate: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
      describe: ReturnType<typeof vi.fn>;
      fetchHistory: ReturnType<typeof vi.fn>;
    };

    let mockHandle: MockHandle;

    beforeEach(() => {
      mockHandle = {
        workflowId: "test-123",
        result: vi.fn().mockResolvedValue({ result: "success" }),
        query: vi.fn(),
        signal: vi.fn().mockResolvedValue(undefined),
        executeUpdate: vi.fn().mockResolvedValue(true),
        terminate: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
        describe: vi.fn().mockResolvedValue({
          workflowId: "test-123",
          type: "testWorkflow",
          status: { name: "RUNNING" },
        }),
        fetchHistory: vi.fn(),
      };

      mockWorkflow.start.mockResolvedValue(mockHandle);
    });

    it("should call result() with Result pattern", async () => {
      const handleResult = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(handleResult).toEqual(expect.objectContaining({ tag: "Ok" }));

      if (handleResult.isOk()) {
        const result = await handleResult.value.result();

        expect(result).toEqual(
          expect.objectContaining({
            tag: "Ok",
            value: { result: "success" },
          }),
        );
      }
    });

    it("should call queries with Result pattern", async () => {
      mockHandle.query.mockResolvedValue("running");

      const handleResult = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(handleResult).toEqual(expect.objectContaining({ tag: "Ok" }));

      if (handleResult.isOk()) {
        const result = await handleResult.value.queries.getStatus([]);

        expect(result).toEqual(expect.objectContaining({ tag: "Ok", value: "running" }));
      }
    });

    it("should call signals with Result pattern", async () => {
      const handleResult = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(handleResult).toEqual(expect.objectContaining({ tag: "Ok" }));

      if (handleResult.isOk()) {
        const result = await handleResult.value.signals.updateProgress([50]);

        expect(result).toEqual(expect.objectContaining({ tag: "Ok" }));
        expect(mockHandle.signal).toHaveBeenCalledWith("updateProgress", [50]);
      }
    });

    it("should call updates with Result pattern", async () => {
      mockHandle.executeUpdate.mockResolvedValue(true);

      const handleResult = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(handleResult).toEqual(expect.objectContaining({ tag: "Ok" }));

      if (handleResult.isOk()) {
        const result = await handleResult.value.updates.setConfig([{ value: "new-config" }]);

        expect(result).toEqual(expect.objectContaining({ tag: "Ok", value: true }));
      }
    });

    it("should call terminate with Result pattern", async () => {
      const handleResult = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(handleResult).toEqual(expect.objectContaining({ tag: "Ok" }));

      if (handleResult.isOk()) {
        const result = await handleResult.value.terminate("test reason");

        expect(result).toEqual(expect.objectContaining({ tag: "Ok" }));
        expect(mockHandle.terminate).toHaveBeenCalledWith("test reason");
      }
    });

    it("should call cancel with Result pattern", async () => {
      const handleResult = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(handleResult).toEqual(expect.objectContaining({ tag: "Ok" }));

      if (handleResult.isOk()) {
        const result = await handleResult.value.cancel();

        expect(result).toEqual(expect.objectContaining({ tag: "Ok" }));
        expect(mockHandle.cancel).toHaveBeenCalled();
      }
    });

    it("should call describe with Result pattern", async () => {
      const handleResult = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(handleResult).toEqual(expect.objectContaining({ tag: "Ok" }));

      if (handleResult.isOk()) {
        const result = await handleResult.value.describe();

        expect(result).toEqual(
          expect.objectContaining({
            tag: "Ok",
            value: expect.objectContaining({ workflowId: "test-123" }),
          }),
        );
      }
    });

    describe("error paths", () => {
      // The buildValidatedProxy refactor centralized validation + runtime-error
      // mapping for queries / signals / updates. These tests pin those paths.

      it("returns QueryValidationError when query input fails validation", async () => {
        const handleResult = await typedClient.startWorkflow("testWorkflow", {
          workflowId: "test-123",
          args: { name: "hello", value: 42 },
        });
        if (!handleResult.isOk()) throw new Error("expected Ok");

        // getStatus expects z.tuple([]); pass a non-tuple to bypass at runtime
        const result = await handleResult.value.queries.getStatus(
          // @ts-expect-error testing runtime validation
          [123],
        );

        expect(result.isError()).toBe(true);
        if (result.isError()) {
          expect(result.error).toBeInstanceOf(QueryValidationError);
          expect((result.error as QueryValidationError).direction).toBe("input");
        }
        expect(mockHandle.query).not.toHaveBeenCalled();
      });

      it("returns QueryValidationError when query output fails validation", async () => {
        // Mock returns a non-string; output schema is z.string()
        mockHandle.query.mockResolvedValue(42);

        const handleResult = await typedClient.startWorkflow("testWorkflow", {
          workflowId: "test-123",
          args: { name: "hello", value: 42 },
        });
        if (!handleResult.isOk()) throw new Error("expected Ok");

        const result = await handleResult.value.queries.getStatus([]);

        expect(result.isError()).toBe(true);
        if (result.isError()) {
          expect(result.error).toBeInstanceOf(QueryValidationError);
          expect((result.error as QueryValidationError).direction).toBe("output");
        }
      });

      it("returns RuntimeClientError when the underlying query call rejects", async () => {
        mockHandle.query.mockRejectedValue(new Error("network down"));

        const handleResult = await typedClient.startWorkflow("testWorkflow", {
          workflowId: "test-123",
          args: { name: "hello", value: 42 },
        });
        if (!handleResult.isOk()) throw new Error("expected Ok");

        const result = await handleResult.value.queries.getStatus([]);

        expect(result.isError()).toBe(true);
        if (result.isError()) {
          expect(result.error).toBeInstanceOf(RuntimeClientError);
          expect((result.error as RuntimeClientError).operation).toBe("query");
        }
      });

      it("returns SignalValidationError when signal input fails validation", async () => {
        const handleResult = await typedClient.startWorkflow("testWorkflow", {
          workflowId: "test-123",
          args: { name: "hello", value: 42 },
        });
        if (!handleResult.isOk()) throw new Error("expected Ok");

        // updateProgress expects z.tuple([z.number()]); pass a string
        const result = await handleResult.value.signals.updateProgress(
          // @ts-expect-error testing runtime validation
          ["not a number"],
        );

        expect(result.isError()).toBe(true);
        if (result.isError()) {
          expect(result.error).toBeInstanceOf(SignalValidationError);
        }
        expect(mockHandle.signal).not.toHaveBeenCalled();
      });

      it("returns RuntimeClientError when the underlying signal call rejects", async () => {
        mockHandle.signal.mockRejectedValue(new Error("connection reset"));

        const handleResult = await typedClient.startWorkflow("testWorkflow", {
          workflowId: "test-123",
          args: { name: "hello", value: 42 },
        });
        if (!handleResult.isOk()) throw new Error("expected Ok");

        const result = await handleResult.value.signals.updateProgress([50]);

        expect(result.isError()).toBe(true);
        if (result.isError()) {
          expect(result.error).toBeInstanceOf(RuntimeClientError);
          expect((result.error as RuntimeClientError).operation).toBe("signal");
        }
      });

      it("returns UpdateValidationError when update input fails validation", async () => {
        const handleResult = await typedClient.startWorkflow("testWorkflow", {
          workflowId: "test-123",
          args: { name: "hello", value: 42 },
        });
        if (!handleResult.isOk()) throw new Error("expected Ok");

        // setConfig expects z.tuple([z.object({ value: z.string() })]);
        // pass an object with the wrong shape
        const result = await handleResult.value.updates.setConfig(
          // @ts-expect-error testing runtime validation
          [{ value: 99 }],
        );

        expect(result.isError()).toBe(true);
        if (result.isError()) {
          expect(result.error).toBeInstanceOf(UpdateValidationError);
          expect((result.error as UpdateValidationError).direction).toBe("input");
        }
        expect(mockHandle.executeUpdate).not.toHaveBeenCalled();
      });

      it("returns UpdateValidationError when update output fails validation", async () => {
        // setConfig output schema is z.boolean(); return a string
        mockHandle.executeUpdate.mockResolvedValue("not a boolean");

        const handleResult = await typedClient.startWorkflow("testWorkflow", {
          workflowId: "test-123",
          args: { name: "hello", value: 42 },
        });
        if (!handleResult.isOk()) throw new Error("expected Ok");

        const result = await handleResult.value.updates.setConfig([{ value: "ok" }]);

        expect(result.isError()).toBe(true);
        if (result.isError()) {
          expect(result.error).toBeInstanceOf(UpdateValidationError);
          expect((result.error as UpdateValidationError).direction).toBe("output");
        }
      });

      it("returns RuntimeClientError when the underlying update call rejects", async () => {
        mockHandle.executeUpdate.mockRejectedValue(new Error("update timeout"));

        const handleResult = await typedClient.startWorkflow("testWorkflow", {
          workflowId: "test-123",
          args: { name: "hello", value: 42 },
        });
        if (!handleResult.isOk()) throw new Error("expected Ok");

        const result = await handleResult.value.updates.setConfig([{ value: "ok" }]);

        expect(result.isError()).toBe(true);
        if (result.isError()) {
          expect(result.error).toBeInstanceOf(RuntimeClientError);
          expect((result.error as RuntimeClientError).operation).toBe("update");
        }
      });
    });
  });

  describe("Result pattern matching", () => {
    it("should support match() on results", async () => {
      mockWorkflow.execute.mockResolvedValue({ result: "success" });

      const result = await typedClient.executeWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      let matched = false;
      result.match({
        Ok: (value) => {
          matched = true;
          expect(value).toEqual({ result: "success" });
        },
        Error: () => {
          throw new Error("Should not be called");
        },
      });

      expect(matched).toBe(true);
    });

    it("should support map() on Ok results", async () => {
      mockWorkflow.execute.mockResolvedValue({ result: "success" });

      const result = await typedClient.executeWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      const mapped = result.map((value) => value.result.toUpperCase());

      expect(mapped).toEqual(expect.objectContaining({ tag: "Ok", value: "SUCCESS" }));
    });
  });
});
