import { defineContract, defineSearchAttribute, defineWorkflow } from "@temporal-contract/contract";
import { ContractError, TechnicalError } from "@temporal-contract/contract/errors";
import {
  type Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowFailedError as TemporalWorkflowFailedError,
} from "@temporalio/client";
import {
  ApplicationFailure,
  defineSearchAttributeKey,
  TypedSearchAttributes,
  WorkflowNotFoundError as TemporalWorkflowNotFoundError,
} from "@temporalio/common";
import { tag } from "unthrown";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

import { readTypedSearchAttributes, TypedClient } from "./client.js";
import {
  QueryValidationError,
  RuntimeClientError,
  SignalValidationError,
  UpdateValidationError,
  WorkflowAlreadyStartedError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
  WorkflowNotFoundError,
  WorkflowValidationError,
} from "./errors.js";
import type { ClientInterceptor } from "./interceptors.js";

// Create mock workflow object
const createMockWorkflow = () => ({
  start: vi.fn(),
  execute: vi.fn(),
  getHandle: vi.fn(),
  signalWithStart: vi.fn(),
});

// Mock schedule client — TypedClient's constructor wires this up via
// `client.schedule`, and bails with a clear error if it's absent (since the
// Schedule API was added in @temporalio/client 1.16).
const mockSchedule = {
  create: vi.fn(),
  getHandle: vi.fn(),
  list: vi.fn(),
};

// Mock Temporal Client
const mockWorkflow = createMockWorkflow();

// The Temporal error classes are mocked here as constructable stand-ins:
// the typed client uses `instanceof` to discriminate them, so the mock must
// expose real classes. If they were left undefined, `instanceof` would
// throw a TypeError that escapes to the makeFuture catch and surfaces as
// `RuntimeClientError("unexpected")` — masking the real classification.
//
// vi.mock factories are hoisted, so the class declarations live inside the
// factory rather than at the top level.
vi.mock("@temporalio/client", () => {
  class WorkflowExecutionAlreadyStartedError extends Error {
    constructor(
      message: string,
      public readonly workflowId: string,
      public readonly workflowType: string,
    ) {
      super(message);
    }
  }
  // Mirrors Temporal's real `WorkflowFailedError` shape (message, cause,
  // retryState). The `cause` field name matches the SDK so the
  // cause-forwarding logic in `classifyResultError` exercises the same
  // property access as it does at runtime.
  class WorkflowFailedError extends Error {
    constructor(
      message: string,
      public override readonly cause: Error | undefined,
      public readonly retryState: string,
    ) {
      super(message);
    }
  }
  return {
    WorkflowHandle: vi.fn(),
    WorkflowExecutionAlreadyStartedError,
    WorkflowFailedError,
  };
});

vi.mock("@temporalio/common", async () => {
  const actual = await vi.importActual<typeof import("@temporalio/common")>("@temporalio/common");
  class WorkflowNotFoundError extends Error {
    constructor(
      message: string,
      public readonly workflowId: string,
      public readonly runId: string | undefined,
    ) {
      super(message);
    }
  }
  return {
    ...actual,
    WorkflowNotFoundError,
  };
});

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
    const rawClient = { workflow: mockWorkflow, schedule: mockSchedule } as unknown as Client;
    typedClient = TypedClient.createOrThrow(testContract, rawClient);
  });

  describe("TypedClient.create", () => {
    it("returns Ok(TypedClient) for a capable client", async () => {
      const rawClient = { workflow: mockWorkflow, schedule: mockSchedule } as unknown as Client;
      const created = await TypedClient.create({ contract: testContract, client: rawClient });
      expect(created).toBeOk();
      if (created.isOk()) {
        expect(created.value).toBeInstanceOf(TypedClient);
      }
    });

    it("surfaces a missing Schedule API as a Defect(TechnicalError) instead of throwing", async () => {
      const oldClient = { workflow: mockWorkflow } as unknown as Client;
      const created = await TypedClient.create({ contract: testContract, client: oldClient });
      expect(created).toBeDefect();
      if (created.isDefect()) {
        const cause = created.cause;
        expect(cause).toBeInstanceOf(TechnicalError);
        expect((cause as TechnicalError)._tag).toBe("@temporal-contract/TechnicalError");
        expect((cause as TechnicalError).message).toMatch(/requires @temporalio\/client >= 1\.16/);
      }
    });

    it("surfaces an eager-connection failure as a Defect(TechnicalError)", async () => {
      const failing = new Error("connection refused");
      const rawClient = {
        workflow: mockWorkflow,
        schedule: mockSchedule,
        connection: { ensureConnected: vi.fn().mockRejectedValue(failing) },
      } as unknown as Client;
      const created = await TypedClient.create({ contract: testContract, client: rawClient });
      expect(created).toBeDefect();
      if (created.isDefect()) {
        const cause = created.cause;
        expect(cause).toBeInstanceOf(TechnicalError);
        expect((cause as TechnicalError)._tag).toBe("@temporal-contract/TechnicalError");
        expect((cause as TechnicalError).cause).toBe(failing);
      }
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

      expect(result).toBeOk();
      if (result.isOk()) {
        expect(result.value).toEqual(
          expect.objectContaining({
            workflowId: "test-123",
          }),
        );
      }

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

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowValidationError);
      }
    });

    it("should return Error result for non-existent workflow", async () => {
      const result = await typedClient.startWorkflow(
        "nonExistentWorkflow" as unknown as "testWorkflow",
        {
          workflowId: "test-123",
          args: {} as unknown as { name: string; value: number },
        },
      );

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowNotFoundError);
      }
    });
  });

  describe("executeWorkflow", () => {
    it("should execute a workflow with valid input and return Ok result", async () => {
      mockWorkflow.execute.mockResolvedValue({ result: "success" });

      const result = await typedClient.executeWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(result).toBeOk();
      if (result.isOk()) {
        expect(result.value).toEqual({ result: "success" });
      }

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

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowValidationError);
      }
    });

    it("surfaces a Defect(RuntimeClientError) when workflow execution throws an unrecognized error", async () => {
      mockWorkflow.execute.mockRejectedValue(new Error("Workflow execution failed"));

      const result = await typedClient.executeWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(result).toBeDefect();
      if (result.isDefect()) {
        expect(result.cause).toBeInstanceOf(RuntimeClientError);
        expect((result.cause as RuntimeClientError).operation).toBe("executeWorkflow");
      }
    });
  });

  describe("signalWithStart", () => {
    const mockHandle = (): {
      workflowId: string;
      signaledRunId: string;
      result: ReturnType<typeof vi.fn>;
      query: ReturnType<typeof vi.fn>;
      signal: ReturnType<typeof vi.fn>;
      executeUpdate: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
      cancel: ReturnType<typeof vi.fn>;
      describe: ReturnType<typeof vi.fn>;
      fetchHistory: ReturnType<typeof vi.fn>;
    } => ({
      workflowId: "test-123",
      signaledRunId: "run-abc",
      result: vi.fn(),
      query: vi.fn(),
      signal: vi.fn(),
      executeUpdate: vi.fn(),
      terminate: vi.fn(),
      cancel: vi.fn(),
      describe: vi.fn(),
      fetchHistory: vi.fn(),
    });

    it("validates workflow + signal input, calls Temporal, and returns a handle with signaledRunId", async () => {
      const handle = mockHandle();
      mockWorkflow.signalWithStart.mockResolvedValue(handle);

      const result = await typedClient.signalWithStart("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
        signalName: "updateProgress",
        signalArgs: [50],
      });

      expect(result).toBeOk();
      if (result.isOk()) {
        expect(result.value.workflowId).toBe("test-123");
        expect(result.value.signaledRunId).toBe("run-abc");
      }

      expect(mockWorkflow.signalWithStart).toHaveBeenCalledWith("testWorkflow", {
        workflowId: "test-123",
        taskQueue: "test-queue",
        args: [{ name: "hello", value: 42 }],
        signal: "updateProgress",
        signalArgs: [[50]],
      });
    });

    it("returns WorkflowNotFoundError when the workflow isn't declared", async () => {
      const result = await typedClient.signalWithStart(
        // @ts-expect-error testing runtime validation
        "nonExistent",
        {
          workflowId: "test-123",
          args: { name: "hello", value: 42 },
          signalName: "updateProgress",
          signalArgs: [50],
        },
      );

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowNotFoundError);
      }
      expect(mockWorkflow.signalWithStart).not.toHaveBeenCalled();
    });

    it("returns WorkflowValidationError when workflow input fails validation", async () => {
      const result = await typedClient.signalWithStart("testWorkflow", {
        workflowId: "test-123",
        // @ts-expect-error testing runtime validation
        args: { name: "hello" }, // missing 'value'
        signalName: "updateProgress",
        signalArgs: [50],
      });

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowValidationError);
      }
      expect(mockWorkflow.signalWithStart).not.toHaveBeenCalled();
    });

    it("returns SignalValidationError when signal input fails validation", async () => {
      const result = await typedClient.signalWithStart("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
        signalName: "updateProgress",
        // @ts-expect-error testing runtime validation
        signalArgs: ["not a number"],
      });

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(SignalValidationError);
      }
      expect(mockWorkflow.signalWithStart).not.toHaveBeenCalled();
    });

    it("surfaces a Defect(RuntimeClientError) when the underlying Temporal call rejects", async () => {
      mockWorkflow.signalWithStart.mockRejectedValue(new Error("temporal down"));

      const result = await typedClient.signalWithStart("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
        signalName: "updateProgress",
        signalArgs: [50],
      });

      expect(result).toBeDefect();
      if (result.isDefect()) {
        expect(result.cause).toBeInstanceOf(RuntimeClientError);
        expect((result.cause as RuntimeClientError).operation).toBe("signalWithStart");
      }
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

      expect(result).toBeOk();
      if (result.isOk()) {
        expect(result.value).toEqual(expect.objectContaining({ workflowId: "test-123" }));
      }
    });

    it("should return Error result for non-existent workflow", async () => {
      const result = await typedClient.getHandle(
        "nonExistentWorkflow" as unknown as "testWorkflow",
        "test-123",
      );

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowNotFoundError);
      }
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

      expect(handleResult).toBeOk();

      if (handleResult.isOk()) {
        const result = await handleResult.value.result();

        expect(result).toBeOk();
        if (result.isOk()) {
          expect(result.value).toEqual({ result: "success" });
        }
      }
    });

    it("should call queries with Result pattern", async () => {
      mockHandle.query.mockResolvedValue("running");

      const handleResult = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(handleResult).toBeOk();

      if (handleResult.isOk()) {
        const result = await handleResult.value.queries.getStatus([]);

        expect(result).toBeOk();
        if (result.isOk()) {
          expect(result.value).toEqual("running");
        }
      }
    });

    it("should call signals with Result pattern", async () => {
      const handleResult = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(handleResult).toBeOk();

      if (handleResult.isOk()) {
        const result = await handleResult.value.signals.updateProgress([50]);

        expect(result).toBeOk();
        expect(mockHandle.signal).toHaveBeenCalledWith("updateProgress", [50]);
      }
    });

    it("should call updates with Result pattern", async () => {
      mockHandle.executeUpdate.mockResolvedValue(true);

      const handleResult = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(handleResult).toBeOk();

      if (handleResult.isOk()) {
        const result = await handleResult.value.updates.setConfig([{ value: "new-config" }]);

        expect(result).toBeOk();
        if (result.isOk()) {
          expect(result.value).toEqual(true);
        }
      }
    });

    it("should call terminate with Result pattern", async () => {
      const handleResult = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(handleResult).toBeOk();

      if (handleResult.isOk()) {
        const result = await handleResult.value.terminate("test reason");

        expect(result).toBeOk();
        expect(mockHandle.terminate).toHaveBeenCalledWith("test reason");
      }
    });

    it("should call cancel with Result pattern", async () => {
      const handleResult = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(handleResult).toBeOk();

      if (handleResult.isOk()) {
        const result = await handleResult.value.cancel();

        expect(result).toBeOk();
        expect(mockHandle.cancel).toHaveBeenCalled();
      }
    });

    it("should call describe with Result pattern", async () => {
      const handleResult = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(handleResult).toBeOk();

      if (handleResult.isOk()) {
        const result = await handleResult.value.describe();

        expect(result).toBeOk();
        if (result.isOk()) {
          expect(result.value).toEqual(expect.objectContaining({ workflowId: "test-123" }));
        }
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

        expect(result).toBeErr();
        if (result.isErr()) {
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

        expect(result).toBeErr();
        if (result.isErr()) {
          expect(result.error).toBeInstanceOf(QueryValidationError);
          expect((result.error as QueryValidationError).direction).toBe("output");
        }
      });

      it("surfaces a Defect(RuntimeClientError) when the underlying query call rejects", async () => {
        mockHandle.query.mockRejectedValue(new Error("network down"));

        const handleResult = await typedClient.startWorkflow("testWorkflow", {
          workflowId: "test-123",
          args: { name: "hello", value: 42 },
        });
        if (!handleResult.isOk()) throw new Error("expected Ok");

        const result = await handleResult.value.queries.getStatus([]);

        expect(result).toBeDefect();
        if (result.isDefect()) {
          expect(result.cause).toBeInstanceOf(RuntimeClientError);
          expect((result.cause as RuntimeClientError).operation).toBe("query");
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

        expect(result).toBeErr();
        if (result.isErr()) {
          expect(result.error).toBeInstanceOf(SignalValidationError);
        }
        expect(mockHandle.signal).not.toHaveBeenCalled();
      });

      it("surfaces a Defect(RuntimeClientError) when the underlying signal call rejects", async () => {
        mockHandle.signal.mockRejectedValue(new Error("connection reset"));

        const handleResult = await typedClient.startWorkflow("testWorkflow", {
          workflowId: "test-123",
          args: { name: "hello", value: 42 },
        });
        if (!handleResult.isOk()) throw new Error("expected Ok");

        const result = await handleResult.value.signals.updateProgress([50]);

        expect(result).toBeDefect();
        if (result.isDefect()) {
          expect(result.cause).toBeInstanceOf(RuntimeClientError);
          expect((result.cause as RuntimeClientError).operation).toBe("signal");
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

        expect(result).toBeErr();
        if (result.isErr()) {
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

        expect(result).toBeErr();
        if (result.isErr()) {
          expect(result.error).toBeInstanceOf(UpdateValidationError);
          expect((result.error as UpdateValidationError).direction).toBe("output");
        }
      });

      it("surfaces a Defect(RuntimeClientError) when the underlying update call rejects", async () => {
        mockHandle.executeUpdate.mockRejectedValue(new Error("update timeout"));

        const handleResult = await typedClient.startWorkflow("testWorkflow", {
          workflowId: "test-123",
          args: { name: "hello", value: 42 },
        });
        if (!handleResult.isOk()) throw new Error("expected Ok");

        const result = await handleResult.value.updates.setConfig([{ value: "ok" }]);

        expect(result).toBeDefect();
        if (result.isDefect()) {
          expect(result.cause).toBeInstanceOf(RuntimeClientError);
          expect((result.cause as RuntimeClientError).operation).toBe("update");
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
        ok: (value) => {
          matched = true;
          expect(value).toEqual({ result: "success" });
        },
        errCases: (matcher) =>
          matcher.with(
            tag("@temporal-contract/WorkflowNotFoundError"),
            tag("@temporal-contract/WorkflowValidationError"),
            tag("@temporal-contract/WorkflowAlreadyStartedError"),
            tag("@temporal-contract/WorkflowFailedError"),
            tag("@temporal-contract/WorkflowExecutionNotFoundError"),
            () => {
              throw new Error("Should not be called");
            },
          ),
        defect: () => {
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

      expect(mapped).toBeOk();
      if (mapped.isOk()) {
        expect(mapped.value).toEqual("SUCCESS");
      }
    });
  });

  describe("typed search attributes", () => {
    // Closes #180 — declared search attributes flow through startWorkflow
    // and executeWorkflow as Temporal `typedSearchAttributes`.

    const searchContract = defineContract({
      taskQueue: "search-q",
      workflows: {
        processOrder: defineWorkflow({
          input: z.object({ orderId: z.string() }),
          output: z.object({ status: z.string() }),
          signals: {
            cancel: { input: z.tuple([z.object({ reason: z.string() })]) },
          },
          searchAttributes: {
            customerId: defineSearchAttribute({ kind: "KEYWORD" }),
            priority: defineSearchAttribute({ kind: "INT" }),
            placedAt: defineSearchAttribute({ kind: "DATETIME" }),
            tags: defineSearchAttribute({ kind: "KEYWORD_LIST" }),
            urgent: defineSearchAttribute({ kind: "BOOL" }),
          },
        }),
        plain: defineWorkflow({
          input: z.object({ id: z.string() }),
          output: z.object({}),
        }),
      },
    });

    let searchClient: TypedClient<typeof searchContract>;

    beforeEach(() => {
      vi.clearAllMocks();
      const rawClient = { workflow: mockWorkflow, schedule: mockSchedule } as unknown as Client;
      searchClient = TypedClient.createOrThrow(searchContract, rawClient);
    });

    it("translates declared searchAttributes into Temporal's typedSearchAttributes", async () => {
      const placedAt = new Date("2026-01-01T00:00:00Z");
      mockWorkflow.start.mockResolvedValue({
        workflowId: "order-1",
        result: vi.fn(),
        query: vi.fn(),
        signal: vi.fn(),
        executeUpdate: vi.fn(),
        terminate: vi.fn(),
        cancel: vi.fn(),
        describe: vi.fn(),
        fetchHistory: vi.fn(),
      });

      const result = await searchClient.startWorkflow("processOrder", {
        workflowId: "order-1",
        args: { orderId: "ORD-1" },
        searchAttributes: {
          customerId: "CUST-1",
          priority: 3,
          placedAt,
          tags: ["urgent", "vip"],
          urgent: true,
        },
      });

      expect(result).toBeOk();
      const call = mockWorkflow.start.mock.calls[0];
      expect(call?.[0]).toBe("processOrder");
      const passed = call?.[1] as { typedSearchAttributes?: TypedSearchAttributes };
      expect(passed.typedSearchAttributes).toBeInstanceOf(TypedSearchAttributes);
    });

    it("omits typedSearchAttributes entirely when no searchAttributes are provided", async () => {
      mockWorkflow.start.mockResolvedValue({
        workflowId: "order-1",
        result: vi.fn(),
        query: vi.fn(),
        signal: vi.fn(),
        executeUpdate: vi.fn(),
        terminate: vi.fn(),
        cancel: vi.fn(),
        describe: vi.fn(),
        fetchHistory: vi.fn(),
      });

      await searchClient.startWorkflow("processOrder", {
        workflowId: "order-1",
        args: { orderId: "ORD-1" },
      });

      const passed = mockWorkflow.start.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(passed).not.toHaveProperty("typedSearchAttributes");
    });

    it("works on executeWorkflow too", async () => {
      mockWorkflow.execute.mockResolvedValue({ status: "ok" });

      await searchClient.executeWorkflow("processOrder", {
        workflowId: "order-1",
        args: { orderId: "ORD-1" },
        searchAttributes: { customerId: "CUST-1" },
      });

      const passed = mockWorkflow.execute.mock.calls[0]?.[1] as {
        typedSearchAttributes?: TypedSearchAttributes;
      };
      expect(passed.typedSearchAttributes).toBeInstanceOf(TypedSearchAttributes);
    });

    it("translates declared searchAttributes through signalWithStart", async () => {
      // Regression: signalWithStart now flows through the same
      // resolveDefinitionAndValidateInput helper as start/execute, so the
      // typed search-attribute translation must fire there as well.
      mockWorkflow.signalWithStart.mockResolvedValue({
        workflowId: "order-1",
        signaledRunId: "run-abc",
        result: vi.fn(),
        query: vi.fn(),
        signal: vi.fn(),
        executeUpdate: vi.fn(),
        terminate: vi.fn(),
        cancel: vi.fn(),
        describe: vi.fn(),
        fetchHistory: vi.fn(),
      });

      await searchClient.signalWithStart("processOrder", {
        workflowId: "order-1",
        args: { orderId: "ORD-1" },
        signalName: "cancel",
        signalArgs: [{ reason: "duplicate" }],
        searchAttributes: { customerId: "CUST-1" },
      });

      const passed = mockWorkflow.signalWithStart.mock.calls[0]?.[1] as {
        typedSearchAttributes?: TypedSearchAttributes;
      };
      expect(passed.typedSearchAttributes).toBeInstanceOf(TypedSearchAttributes);
    });

    it("rejects attribute keys that aren't declared on the workflow at runtime", async () => {
      // Type-system catches this at the call site, but the runtime guard
      // exists for typed-escape-hatch cases (`as never`, `as any`,
      // raw-call interop) where a typo would otherwise silently drop the
      // attribute and leave the workflow unindexed without any signal.
      const result = await searchClient.startWorkflow("processOrder", {
        workflowId: "order-1",
        args: { orderId: "ORD-1" },
        searchAttributes: {
          customerId: "CUST-1",
          // @ts-expect-error — `unknownAttr` isn't declared on processOrder
          unknownAttr: "ignored",
        },
      });

      expect(result).toBeDefect();
      if (result.isDefect()) {
        expect(result.cause).toBeInstanceOf(RuntimeClientError);
        const op = (result.cause as RuntimeClientError).operation;
        expect(op).toBe("searchAttributes");
        expect((result.cause as RuntimeClientError).message).toContain("unknownAttr");
      }
      // Temporal must NOT have been called with the bad attribute.
      expect(mockWorkflow.start).not.toHaveBeenCalled();
    });

    it("rejects searchAttributes when the workflow declares no searchAttributes block at all", async () => {
      // Regression: workflows that omit the `searchAttributes` field
      // entirely (no block at all) used to silently drop any caller-
      // supplied values via an early return on `!workflowDef.searchAttributes`,
      // re-introducing the escape-hatch gap on a different path. The helper
      // now treats the missing block as an empty declared map so the
      // per-key "undeclared" check fires uniformly.
      const result = await searchClient.startWorkflow(
        // `plain` declares no searchAttributes; pretend the caller cast
        // through `as any` and tries to attach one anyway.
        "plain",
        {
          workflowId: "plain-1",
          args: { id: "P-1" },
          searchAttributes: { customerId: "CUST-1" } as never,
        },
      );

      expect(result).toBeDefect();
      if (result.isDefect()) {
        expect(result.cause).toBeInstanceOf(RuntimeClientError);
        expect((result.cause as RuntimeClientError).operation).toBe("searchAttributes");
        expect((result.cause as RuntimeClientError).message).toContain("customerId");
      }
      expect(mockWorkflow.start).not.toHaveBeenCalled();
    });

    it("readTypedSearchAttributes round-trips declared keys with proper types", () => {
      // Build a TypedSearchAttributes instance the way Temporal would
      // populate one in `describe()`'s response, then round-trip through
      // the public reader and assert the values come back narrowed.
      const placedAt = new Date("2026-04-01T00:00:00Z");
      const instance = new TypedSearchAttributes([
        { key: defineSearchAttributeKey("customerId", "KEYWORD"), value: "CUST-9" },
        { key: defineSearchAttributeKey("priority", "INT"), value: 7 },
        { key: defineSearchAttributeKey("placedAt", "DATETIME"), value: placedAt },
        { key: defineSearchAttributeKey("urgent", "BOOL"), value: true },
        { key: defineSearchAttributeKey("tags", "KEYWORD_LIST"), value: ["a", "b"] },
      ]);

      const attrs = readTypedSearchAttributes(searchContract.workflows.processOrder, instance);

      expect(attrs.customerId).toBe("CUST-9");
      expect(attrs.priority).toBe(7);
      expect(attrs.placedAt).toEqual(placedAt);
      expect(attrs.urgent).toBe(true);
      expect(attrs.tags).toEqual(["a", "b"]);
    });

    it("readTypedSearchAttributes returns {} for workflows with no declared attributes", () => {
      const instance = new TypedSearchAttributes([]);
      const attrs = readTypedSearchAttributes(searchContract.workflows.plain, instance);
      expect(attrs).toEqual({});
    });
  });

  describe("typed Temporal error discrimination", () => {
    // Closes #184 — Temporal's typed error classes flow through the typed
    // client surface as discriminated Result.Error variants instead of
    // collapsing into a generic `RuntimeClientError`.

    it("startWorkflow surfaces WorkflowAlreadyStartedError when Temporal rejects with WorkflowExecutionAlreadyStartedError", async () => {
      mockWorkflow.start.mockRejectedValue(
        new WorkflowExecutionAlreadyStartedError("already started", "test-123", "testWorkflow"),
      );

      const result = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowAlreadyStartedError);
        const err = result.error as WorkflowAlreadyStartedError;
        expect(err.workflowId).toBe("test-123");
        expect(err.workflowType).toBe("testWorkflow");
        expect(err.cause).toBeInstanceOf(WorkflowExecutionAlreadyStartedError);
      }
    });

    it("startWorkflow falls through to a Defect(RuntimeClientError) for unrelated errors", async () => {
      mockWorkflow.start.mockRejectedValue(new Error("network down"));

      const result = await typedClient.startWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(result).toBeDefect();
      if (result.isDefect()) {
        expect(result.cause).toBeInstanceOf(RuntimeClientError);
        expect(result.cause).not.toBeInstanceOf(WorkflowAlreadyStartedError);
        expect((result.cause as RuntimeClientError).operation).toBe("startWorkflow");
      }
    });

    it("signalWithStart surfaces WorkflowAlreadyStartedError too", async () => {
      mockWorkflow.signalWithStart.mockRejectedValue(
        new WorkflowExecutionAlreadyStartedError("already started", "test-123", "testWorkflow"),
      );

      const result = await typedClient.signalWithStart("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
        signalName: "updateProgress",
        signalArgs: [50],
      });

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowAlreadyStartedError);
      }
    });

    it("executeWorkflow surfaces WorkflowAlreadyStartedError when start collides", async () => {
      mockWorkflow.execute.mockRejectedValue(
        new WorkflowExecutionAlreadyStartedError("already started", "test-123", "testWorkflow"),
      );

      const result = await typedClient.executeWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowAlreadyStartedError);
      }
    });

    it("executeWorkflow surfaces WorkflowFailedError with the inner Temporal cause unwrapped", async () => {
      // Temporal's `WorkflowFailedError` is a wrapper; the actionable
      // failure (ApplicationFailure / CancelledFailure / ...) lives on its
      // `cause`. The typed client lifts that inner cause directly so
      // consumers can match `err.cause` in one step instead of unwrapping
      // through Temporal's wrapper.
      const innerFailure = new Error("application failure: payment_declined");
      mockWorkflow.execute.mockRejectedValue(
        new TemporalWorkflowFailedError("workflow failed", innerFailure, "NON_RETRYABLE_FAILURE"),
      );

      const result = await typedClient.executeWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowFailedError);
        const err = result.error as WorkflowFailedError;
        expect(err.workflowId).toBe("test-123");
        // Cause should be the *inner* failure, not Temporal's wrapper.
        expect(err.cause).toBe(innerFailure);
        expect(err.cause).not.toBeInstanceOf(TemporalWorkflowFailedError);
      }
    });

    it("executeWorkflow surfaces WorkflowExecutionNotFoundError on missing exec", async () => {
      mockWorkflow.execute.mockRejectedValue(
        new TemporalWorkflowNotFoundError("not found", "test-123", "run-1"),
      );

      const result = await typedClient.executeWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowExecutionNotFoundError);
        const err = result.error as WorkflowExecutionNotFoundError;
        expect(err.workflowId).toBe("test-123");
        expect(err.runId).toBe("run-1");
      }
    });

    it("handle.result() surfaces WorkflowFailedError with the inner Temporal cause unwrapped", async () => {
      const innerFailure = new Error("activity failure");
      const handle = {
        workflowId: "test-123",
        result: vi
          .fn()
          .mockRejectedValue(
            new TemporalWorkflowFailedError("failed", innerFailure, "NON_RETRYABLE_FAILURE"),
          ),
        query: vi.fn(),
        signal: vi.fn(),
        executeUpdate: vi.fn(),
        terminate: vi.fn(),
        cancel: vi.fn(),
        describe: vi.fn(),
        fetchHistory: vi.fn(),
      };
      mockWorkflow.getHandle.mockReturnValue(handle);

      const handleResult = await typedClient.getHandle("testWorkflow", "test-123");
      if (!handleResult.isOk()) throw new Error("getHandle should succeed");
      const result = await handleResult.value.result();

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowFailedError);
        const err = result.error as WorkflowFailedError;
        expect(err.workflowId).toBe("test-123");
        // The inner cause is forwarded, not Temporal's wrapper.
        expect(err.cause).toBe(innerFailure);
        expect(err.cause).not.toBeInstanceOf(TemporalWorkflowFailedError);
      }
    });

    it("falls back to handle.workflowId when Temporal's WorkflowNotFoundError carries an empty workflowId", async () => {
      // Temporal's runtime sometimes constructs WorkflowNotFoundError with
      // workflowId = "" (when the upstream error doesn't include the id).
      // The typed client's classify helpers fall back to the handle's
      // workflowId so the surfaced error always identifies the targeted
      // execution. Without this, callers would see
      // `Workflow execution "" not found in namespace.`
      const handle = {
        workflowId: "test-123",
        result: vi.fn(),
        query: vi.fn(),
        signal: vi.fn(),
        executeUpdate: vi.fn(),
        terminate: vi.fn(),
        cancel: vi
          .fn()
          .mockRejectedValue(new TemporalWorkflowNotFoundError("not found", "", undefined)),
        describe: vi.fn(),
        fetchHistory: vi.fn(),
      };
      mockWorkflow.getHandle.mockReturnValue(handle);

      const handleResult = await typedClient.getHandle("testWorkflow", "test-123");
      if (!handleResult.isOk()) throw new Error("getHandle should succeed");
      const result = await handleResult.value.cancel();

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowExecutionNotFoundError);
        const err = result.error as WorkflowExecutionNotFoundError;
        // Fallback applied: the handle's workflowId rather than the
        // empty string from Temporal's error.
        expect(err.workflowId).toBe("test-123");
      }
    });

    it("handle.terminate() surfaces WorkflowExecutionNotFoundError", async () => {
      const handle = {
        workflowId: "test-123",
        result: vi.fn(),
        query: vi.fn(),
        signal: vi.fn(),
        executeUpdate: vi.fn(),
        terminate: vi
          .fn()
          .mockRejectedValue(new TemporalWorkflowNotFoundError("not found", "test-123", undefined)),
        cancel: vi.fn(),
        describe: vi.fn(),
        fetchHistory: vi.fn(),
      };
      mockWorkflow.getHandle.mockReturnValue(handle);

      const handleResult = await typedClient.getHandle("testWorkflow", "test-123");
      if (!handleResult.isOk()) throw new Error("getHandle should succeed");
      const result = await handleResult.value.terminate("done");

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowExecutionNotFoundError);
      }
    });

    it("handle.signals.* surfaces WorkflowExecutionNotFoundError", async () => {
      const handle = {
        workflowId: "test-123",
        result: vi.fn(),
        query: vi.fn(),
        signal: vi
          .fn()
          .mockRejectedValue(new TemporalWorkflowNotFoundError("not found", "test-123", undefined)),
        executeUpdate: vi.fn(),
        terminate: vi.fn(),
        cancel: vi.fn(),
        describe: vi.fn(),
        fetchHistory: vi.fn(),
      };
      mockWorkflow.getHandle.mockReturnValue(handle);

      const handleResult = await typedClient.getHandle("testWorkflow", "test-123");
      if (!handleResult.isOk()) throw new Error("getHandle should succeed");
      const result = await handleResult.value.signals.updateProgress([50]);

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowExecutionNotFoundError);
      }
    });

    it("preserves Temporal's runId on WorkflowExecutionNotFoundError", async () => {
      const handle = {
        workflowId: "test-123",
        result: vi.fn(),
        query: vi.fn(),
        signal: vi.fn(),
        executeUpdate: vi.fn(),
        terminate: vi.fn(),
        cancel: vi.fn(),
        describe: vi
          .fn()
          .mockRejectedValue(new TemporalWorkflowNotFoundError("not found", "test-123", "run-xyz")),
        fetchHistory: vi.fn(),
      };
      mockWorkflow.getHandle.mockReturnValue(handle);

      const handleResult = await typedClient.getHandle("testWorkflow", "test-123");
      if (!handleResult.isOk()) throw new Error("getHandle should succeed");
      const result = await handleResult.value.describe();

      expect(result).toBeErr();
      if (result.isErr()) {
        const err = result.error as WorkflowExecutionNotFoundError;
        expect(err).toBeInstanceOf(WorkflowExecutionNotFoundError);
        expect(err.runId).toBe("run-xyz");
      }
    });
  });
});

describe("TypedClient — workflow contract errors", () => {
  const erroredContract = defineContract({
    taskQueue: "test-queue",
    workflows: {
      processOrder: defineWorkflow({
        input: z.object({ orderId: z.string() }),
        output: z.object({ status: z.string() }),
        errors: {
          EmptyOrder: {
            data: z.object({ orderId: z.string() }),
            nonRetryable: true,
          },
        },
      }),
    },
  });

  const createClient = () =>
    TypedClient.createOrThrow(erroredContract, {
      workflow: mockWorkflow,
      schedule: mockSchedule,
    } as unknown as Client);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executeWorkflow rehydrates a declared failure into a typed ContractError", async () => {
    const failure = ApplicationFailure.create({
      type: "EmptyOrder",
      message: "Order has no items",
      nonRetryable: true,
      details: [{ orderId: "ORD-1" }],
    });
    mockWorkflow.execute.mockRejectedValue(
      new TemporalWorkflowFailedError("failed", failure, "NON_RETRYABLE_FAILURE"),
    );

    const result = await createClient().executeWorkflow("processOrder", {
      workflowId: "order-1",
      args: { orderId: "ORD-1" },
    });

    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ContractError);
      const error = result.error as InstanceType<typeof ContractError>;
      expect(error.errorName).toBe("EmptyOrder");
      expect(error.data).toEqual({ orderId: "ORD-1" });
      expect(error.cause).toBe(failure);
    }
  });

  it("executeWorkflow falls back to WorkflowFailedError for undeclared failure types", async () => {
    const failure = ApplicationFailure.create({ type: "SOMETHING_ELSE", message: "boom" });
    mockWorkflow.execute.mockRejectedValue(
      new TemporalWorkflowFailedError("failed", failure, "NON_RETRYABLE_FAILURE"),
    );

    const result = await createClient().executeWorkflow("processOrder", {
      workflowId: "order-1",
      args: { orderId: "ORD-1" },
    });

    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(WorkflowFailedError);
    }
  });

  it("executeWorkflow falls back when the declared payload no longer validates", async () => {
    const failure = ApplicationFailure.create({
      type: "EmptyOrder",
      details: [{ orderId: 42 }],
    });
    mockWorkflow.execute.mockRejectedValue(
      new TemporalWorkflowFailedError("failed", failure, "NON_RETRYABLE_FAILURE"),
    );

    const result = await createClient().executeWorkflow("processOrder", {
      workflowId: "order-1",
      args: { orderId: "ORD-1" },
    });

    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(WorkflowFailedError);
    }
  });

  it("handle.result() rehydrates a declared failure into a typed ContractError", async () => {
    const failure = ApplicationFailure.create({
      type: "EmptyOrder",
      message: "Order has no items",
      details: [{ orderId: "ORD-2" }],
    });
    const rawHandle = {
      workflowId: "order-2",
      result: vi
        .fn()
        .mockRejectedValue(
          new TemporalWorkflowFailedError("failed", failure, "NON_RETRYABLE_FAILURE"),
        ),
      query: vi.fn(),
      signal: vi.fn(),
      executeUpdate: vi.fn(),
    };
    mockWorkflow.getHandle.mockReturnValue(rawHandle);

    const handleResult = await createClient().getHandle("processOrder", "order-2");
    expect(handleResult).toBeOk();
    if (!handleResult.isOk()) return;

    const result = await handleResult.value.result();
    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ContractError);
      const error = result.error as InstanceType<typeof ContractError>;
      expect(error.errorName).toBe("EmptyOrder");
      expect(error.data).toEqual({ orderId: "ORD-2" });
    }
  });
});

describe("TypedClient — interceptors", () => {
  const interceptedContract = defineContract({
    taskQueue: "test-queue",
    workflows: {
      testWorkflow: defineWorkflow({
        input: z.object({ name: z.string(), value: z.number() }),
        output: z.object({ result: z.string() }),
        queries: {
          getStatus: { input: z.tuple([]), output: z.string() },
        },
      }),
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const clientWith = (interceptors: ClientInterceptor[]) =>
    TypedClient.createOrThrow(
      interceptedContract,
      { workflow: mockWorkflow, schedule: mockSchedule } as unknown as Client,
      interceptors,
    );

  it("runs outermost-first, observing the operation", async () => {
    mockWorkflow.execute.mockResolvedValue({ result: "ok" });
    const order: string[] = [];
    const mk =
      (label: string): ClientInterceptor =>
      (args, next) => {
        order.push(`${label}:${args.operation}:${args.workflowName}`);
        return next();
      };

    const result = await clientWith([mk("outer"), mk("inner")]).executeWorkflow("testWorkflow", {
      workflowId: "wf-1",
      args: { name: "n", value: 1 },
    });

    expect(result).toBeOk();
    expect(order).toEqual([
      "outer:executeWorkflow:testWorkflow",
      "inner:executeWorkflow:testWorkflow",
    ]);
  });

  it("patched input flows through the normal validation pipeline", async () => {
    mockWorkflow.execute.mockResolvedValue({ result: "ok" });
    const patching: ClientInterceptor = (_args, next) =>
      next({ input: { name: "patched", value: 42 } });

    const result = await clientWith([patching]).executeWorkflow("testWorkflow", {
      workflowId: "wf-2",
      args: { name: "original", value: 1 },
    });

    expect(result).toBeOk();
    expect(mockWorkflow.execute).toHaveBeenCalledWith(
      "testWorkflow",
      expect.objectContaining({ args: [{ name: "patched", value: 42 }] }),
    );
  });

  it("an invalid patched input is rejected by validation (no bypass)", async () => {
    const patching: ClientInterceptor = (_args, next) => next({ input: { name: 42 } });

    const result = await clientWith([patching]).executeWorkflow("testWorkflow", {
      workflowId: "wf-3",
      args: { name: "original", value: 1 },
    });

    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(WorkflowValidationError);
    }
    expect(mockWorkflow.execute).not.toHaveBeenCalled();
  });

  it("can retry by calling next again", async () => {
    mockWorkflow.execute
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ result: "ok" });
    // A transient Temporal failure now rides the defect channel (a
    // `RuntimeClientError` cause), so the retry re-enters via `recoverDefect`
    // rather than a modeled-error matcher — a defect is the retry signal, and
    // any genuinely-modeled `Err` still flows through untouched.
    const retryOnce: ClientInterceptor = (_args, next) => next().recoverDefect(() => next());

    const result = await clientWith([retryOnce]).executeWorkflow("testWorkflow", {
      workflowId: "wf-4",
      args: { name: "n", value: 1 },
    });

    expect(result).toBeOk();
    expect(mockWorkflow.execute).toHaveBeenCalledTimes(2);
  });

  it("wraps handle-level interactions (query)", async () => {
    const rawHandle = {
      workflowId: "wf-5",
      result: vi.fn(),
      query: vi.fn().mockResolvedValue("running"),
      signal: vi.fn(),
      executeUpdate: vi.fn(),
    };
    mockWorkflow.getHandle.mockReturnValue(rawHandle);
    const seen: unknown[] = [];
    const observing: ClientInterceptor = (args, next) => {
      seen.push(args);
      return next();
    };

    const handleResult = await clientWith([observing]).getHandle("testWorkflow", "wf-5");
    expect(handleResult).toBeOk();
    if (!handleResult.isOk()) return;
    const query = await handleResult.value.queries.getStatus([]);

    expect(query).toBeOk();
    expect(seen).toEqual([
      {
        operation: "query",
        workflowName: "testWorkflow",
        workflowId: "wf-5",
        name: "getStatus",
        input: [],
      },
    ]);
  });
});
