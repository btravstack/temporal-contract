import {
  defineContract,
  defineQuery,
  defineSearchAttribute,
  defineSignal,
  defineUpdate,
  defineWorkflow,
} from "@temporal-contract/contract";
import { ContractError, TechnicalError } from "@temporal-contract/contract/errors";
import {
  type Client,
  QueryNotRegisteredError as TemporalQueryNotRegisteredError,
  WorkflowExecutionAlreadyStartedError,
  WorkflowFailedError as TemporalWorkflowFailedError,
  WorkflowUpdateFailedError as TemporalWorkflowUpdateFailedError,
} from "@temporalio/client";
import {
  ApplicationFailure,
  CancelledFailure,
  defineSearchAttributeKey,
  TerminatedFailure,
  TimeoutFailure,
  TimeoutType,
  TypedSearchAttributes,
  WorkflowNotFoundError as TemporalWorkflowNotFoundError,
} from "@temporalio/common";
import { P } from "unthrown";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

import { ContractClient, readTypedSearchAttributes, TypedClient } from "./client.js";
import {
  WORKFLOW_ALREADY_STARTED_ERROR_TAG,
  WORKFLOW_CANCELLED_ERROR_TAG,
  WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG,
  WORKFLOW_FAILED_ERROR_TAG,
  WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG,
  WORKFLOW_TERMINATED_ERROR_TAG,
  WORKFLOW_TIMEOUT_ERROR_TAG,
  WORKFLOW_VALIDATION_ERROR_TAG,
} from "./error-tags.js";
import {
  QueryFailedError,
  QueryValidationError,
  RuntimeClientError,
  SignalValidationError,
  UpdateFailedError,
  UpdateRejectedError,
  UpdateValidationError,
  WorkflowAlreadyStartedError,
  WorkflowCancelledError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
  WorkflowNotInContractError,
  WorkflowTerminatedError,
  WorkflowTimeoutError,
  WorkflowValidationError,
} from "./errors.js";

/**
 * Test construction helper: build the connection-scoped root and bind the
 * contract in one step. `create`'s Err channel is `never`, so `.get()`
 * unwraps directly (a setup defect rethrows its cause).
 */
async function bindContract<TContract extends Parameters<TypedClient["for"]>[0]>(
  contract: TContract,
  rawClient: Client,
): Promise<ContractClient<TContract>> {
  const root = (await TypedClient.create({ client: rawClient })).get();
  return root.for(contract);
}

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
  class ScheduleAlreadyRunning extends Error {
    constructor(
      message: string,
      public readonly scheduleId: string,
    ) {
      super(message);
    }
  }
  class ScheduleNotFoundError extends Error {
    constructor(
      message: string,
      public readonly scheduleId: string,
    ) {
      super(message);
    }
  }
  // Mirrors Temporal's `WorkflowUpdateFailedError` shape (message + cause) —
  // thrown while waiting on an update outcome, for both admission
  // rejections and failed handlers.
  class WorkflowUpdateFailedError extends Error {
    constructor(
      message: string,
      public override readonly cause: Error | undefined,
    ) {
      super(message);
    }
  }
  // Mirrors Temporal's `QueryNotRegisteredError` (message + gRPC code) —
  // thrown for unregistered queries AND throwing query handlers.
  class QueryNotRegisteredError extends Error {
    constructor(
      message: string,
      public readonly code: number,
    ) {
      super(message);
    }
  }
  return {
    WorkflowHandle: vi.fn(),
    WorkflowExecutionAlreadyStartedError,
    WorkflowFailedError,
    WorkflowUpdateFailedError,
    QueryNotRegisteredError,
    ScheduleAlreadyRunning,
    ScheduleNotFoundError,
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
        idempotency: "allow-duplicate",
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
        idempotency: "allow-duplicate",
      },
    },
  });

  let typedClient: ContractClient<typeof testContract>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const rawClient = { workflow: mockWorkflow, schedule: mockSchedule } as unknown as Client;
    typedClient = await bindContract(testContract, rawClient);
  });

  describe("TypedClient.create", () => {
    it("returns Ok(TypedClient) for a capable client", async () => {
      const rawClient = { workflow: mockWorkflow, schedule: mockSchedule } as unknown as Client;
      const created = await TypedClient.create({ client: rawClient });
      expect(created).toBeOk();
      if (created.isOk()) {
        expect(created.value).toBeInstanceOf(TypedClient);
      }
    });

    it("exposes the underlying Client as the `raw` escape hatch", async () => {
      const rawClient = { workflow: mockWorkflow, schedule: mockSchedule } as unknown as Client;
      const created = (await TypedClient.create({ client: rawClient })).get();
      expect(created.raw).toBe(rawClient);
    });

    it("surfaces a missing Schedule API as a Defect(TechnicalError) instead of throwing", async () => {
      const oldClient = { workflow: mockWorkflow } as unknown as Client;
      const created = await TypedClient.create({ client: oldClient });
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
      const created = await TypedClient.create({ client: rawClient });
      expect(created).toBeDefect();
      if (created.isDefect()) {
        const cause = created.cause;
        expect(cause).toBeInstanceOf(TechnicalError);
        expect((cause as TechnicalError)._tag).toBe("@temporal-contract/TechnicalError");
        expect((cause as TechnicalError).cause).toBe(failing);
      }
    });

    it("runs ensureConnected once per root, not once per contract binding", async () => {
      const ensureConnected = vi.fn().mockResolvedValue(undefined);
      const rawClient = {
        workflow: mockWorkflow,
        schedule: mockSchedule,
        connection: { ensureConnected },
      } as unknown as Client;
      const root = (await TypedClient.create({ client: rawClient })).get();
      root.for(testContract);
      root.for(testContract);
      expect(ensureConnected).toHaveBeenCalledTimes(1);
    });
  });

  describe("TypedClient.for", () => {
    const otherContract = defineContract({
      taskQueue: "other-queue",
      workflows: {
        otherWorkflow: defineWorkflow({
          input: z.object({ id: z.string() }),
          output: z.object({ ok: z.boolean() }),
          idempotency: "allow-duplicate",
        }),
      },
    });

    it("is memoized: for(c) twice returns the same instance", async () => {
      const rawClient = { workflow: mockWorkflow, schedule: mockSchedule } as unknown as Client;
      const root = (await TypedClient.create({ client: rawClient })).get();
      expect(root.for(testContract)).toBe(root.for(testContract));
    });

    it("yields distinct instances for distinct contracts", async () => {
      const rawClient = { workflow: mockWorkflow, schedule: mockSchedule } as unknown as Client;
      const root = (await TypedClient.create({ client: rawClient })).get();
      const first = root.for(testContract);
      const second = root.for(otherContract);
      expect(first).not.toBe(second as unknown);
      expect(first).toBeInstanceOf(ContractClient);
      expect(second).toBeInstanceOf(ContractClient);
    });

    it("each binding uses its own contract's taskQueue and schemas", async () => {
      const rawClient = { workflow: mockWorkflow, schedule: mockSchedule } as unknown as Client;
      const root = (await TypedClient.create({ client: rawClient })).get();
      mockWorkflow.start.mockResolvedValue({ workflowId: "x" });

      await root.for(testContract).startWorkflow("testWorkflow", {
        workflowId: "a",
        args: { name: "n", value: 1 },
      });
      await root.for(otherContract).startWorkflow("otherWorkflow", {
        workflowId: "b",
        args: { id: "i" },
      });

      expect(mockWorkflow.start).toHaveBeenNthCalledWith(
        1,
        "testWorkflow",
        expect.objectContaining({ taskQueue: "test-queue" }),
      );
      expect(mockWorkflow.start).toHaveBeenNthCalledWith(
        2,
        "otherWorkflow",
        expect.objectContaining({ taskQueue: "other-queue" }),
      );

      // Each binding validates against its OWN schemas: testContract's
      // input shape is rejected by otherContract's workflow.
      const invalid = await root.for(otherContract).startWorkflow("otherWorkflow", {
        workflowId: "c",
        args: { name: "n", value: 1 } as unknown as { id: string },
      });
      expect(invalid).toBeErr();
      if (invalid.isErr()) {
        expect(invalid.error).toBeInstanceOf(WorkflowValidationError);
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
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
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
        expect(result.error).toBeInstanceOf(WorkflowNotInContractError);
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
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
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
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
        args: [{ name: "hello", value: 42 }],
        signal: "updateProgress",
        signalArgs: [[50]],
      });
    });

    it("returns WorkflowNotInContractError when the workflow isn't declared", async () => {
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
        expect(result.error).toBeInstanceOf(WorkflowNotInContractError);
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

      const result = typedClient.getHandle("testWorkflow", "test-123");

      expect(result).toBeOk();
      if (result.isOk()) {
        expect(result.value).toEqual(expect.objectContaining({ workflowId: "test-123" }));
      }
    });

    it("should return Error result for non-existent workflow", async () => {
      const result = typedClient.getHandle(
        "nonExistentWorkflow" as unknown as "testWorkflow",
        "test-123",
      );

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowNotInContractError);
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
          // Covers executeWorkflow's full error union (start phase +
          // result phase, outcome trio included).
          matcher.with(
            P.tag(WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG),
            P.tag(WORKFLOW_VALIDATION_ERROR_TAG),
            P.tag(WORKFLOW_ALREADY_STARTED_ERROR_TAG),
            P.tag(WORKFLOW_FAILED_ERROR_TAG),
            P.tag(WORKFLOW_CANCELLED_ERROR_TAG),
            P.tag(WORKFLOW_TERMINATED_ERROR_TAG),
            P.tag(WORKFLOW_TIMEOUT_ERROR_TAG),
            P.tag(WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG),
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
          idempotency: "allow-duplicate",
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
          idempotency: "allow-duplicate",
        }),
      },
    });

    let searchClient: ContractClient<typeof searchContract>;

    beforeEach(async () => {
      vi.clearAllMocks();
      const rawClient = { workflow: mockWorkflow, schedule: mockSchedule } as unknown as Client;
      searchClient = await bindContract(searchContract, rawClient);
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

      const handleResult = typedClient.getHandle("testWorkflow", "test-123");
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

    it("executeWorkflow classifies a CancelledFailure cause into WorkflowCancelledError", async () => {
      const cancelled = new CancelledFailure("cancel requested");
      mockWorkflow.execute.mockRejectedValue(
        new TemporalWorkflowFailedError("failed", cancelled, "NON_RETRYABLE_FAILURE"),
      );

      const result = await typedClient.executeWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowCancelledError);
        const err = result.error as WorkflowCancelledError;
        expect(err.workflowId).toBe("test-123");
        // The original CancelledFailure is kept as the cause.
        expect(err.cause).toBe(cancelled);
        // The generic wrapper is NOT used for the outcome trio.
        expect(result.error).not.toBeInstanceOf(WorkflowFailedError);
      }
    });

    it("executeWorkflow classifies a TimeoutFailure cause into WorkflowTimeoutError", async () => {
      const timedOut = new TimeoutFailure(
        "deadline exceeded",
        undefined,
        TimeoutType.START_TO_CLOSE,
      );
      mockWorkflow.execute.mockRejectedValue(
        new TemporalWorkflowFailedError("failed", timedOut, "TIMEOUT"),
      );

      const result = await typedClient.executeWorkflow("testWorkflow", {
        workflowId: "test-123",
        args: { name: "hello", value: 42 },
      });

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowTimeoutError);
        expect((result.error as WorkflowTimeoutError).cause).toBe(timedOut);
      }
    });

    it("handle.result() classifies a TerminatedFailure cause into WorkflowTerminatedError", async () => {
      const terminated = new TerminatedFailure("operator said so");
      const handle = {
        workflowId: "test-123",
        result: vi
          .fn()
          .mockRejectedValue(
            new TemporalWorkflowFailedError("failed", terminated, "NON_RETRYABLE_FAILURE"),
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

      const handleResult = typedClient.getHandle("testWorkflow", "test-123");
      if (!handleResult.isOk()) throw new Error("getHandle should succeed");
      const result = await handleResult.value.result();

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowTerminatedError);
        const err = result.error as WorkflowTerminatedError;
        expect(err.workflowId).toBe("test-123");
        expect(err.cause).toBe(terminated);
        expect(err.message).toContain("operator said so");
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

      const handleResult = typedClient.getHandle("testWorkflow", "test-123");
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

      const handleResult = typedClient.getHandle("testWorkflow", "test-123");
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

      const handleResult = typedClient.getHandle("testWorkflow", "test-123");
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

      const handleResult = typedClient.getHandle("testWorkflow", "test-123");
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

describe("TypedClient — wire format (validate on send, parse on receive)", () => {
  // D1: each payload boundary parses exactly once, on the receiving side.
  // The client validates what it sends (failing early with the typed
  // validation error) but transmits the caller's ORIGINAL value; parsed
  // results are only used on the receive side (workflow/query/update
  // results). Transforming schemas make the two sides observable.
  const transformContract = defineContract({
    taskQueue: "wire-q",
    workflows: {
      transformer: defineWorkflow({
        // Asymmetric transform: input type is `string`, parsed type is `number`.
        input: z.string().transform((s) => s.length),
        output: z.number().transform((n) => n * 2),
        idempotency: "allow-duplicate",
        signals: {
          ping: { input: z.string().transform((s) => s.length) },
        },
        queries: {
          peek: {
            input: z.string().transform((s) => s.length),
            output: z.number().transform((n) => n * 2),
          },
        },
        updates: {
          poke: {
            input: z.string().transform((s) => s.length),
            output: z.number().transform((n) => n * 2),
          },
        },
      }),
    },
  });

  let wireClient: ContractClient<typeof transformContract>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const rawClient = { workflow: mockWorkflow, schedule: mockSchedule } as unknown as Client;
    wireClient = await bindContract(transformContract, rawClient);
  });

  it("startWorkflow transmits the ORIGINAL args, not the parsed value", async () => {
    mockWorkflow.start.mockResolvedValue({ workflowId: "wf-1" });

    const result = await wireClient.startWorkflow("transformer", {
      workflowId: "wf-1",
      args: "hello",
    });

    expect(result).toBeOk();
    expect(mockWorkflow.start).toHaveBeenCalledWith("transformer", {
      workflowId: "wf-1",
      taskQueue: "wire-q",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      args: ["hello"], // original string — not 5 (the parsed length)
    });
  });

  it("startWorkflow still rejects invalid input before dispatch", async () => {
    const result = await wireClient.startWorkflow("transformer", {
      workflowId: "wf-1",
      // @ts-expect-error testing runtime validation
      args: 42,
    });

    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(WorkflowValidationError);
    }
    expect(mockWorkflow.start).not.toHaveBeenCalled();
  });

  it("executeWorkflow transmits the ORIGINAL args and parses the result exactly once", async () => {
    // The wire carries the producer's original (pre-transform) value; the
    // client applies the output transform on receive.
    mockWorkflow.execute.mockResolvedValue(21);

    const result = await wireClient.executeWorkflow("transformer", {
      workflowId: "wf-2",
      args: "hello",
    });

    expect(mockWorkflow.execute).toHaveBeenCalledWith("transformer", {
      workflowId: "wf-2",
      taskQueue: "wire-q",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      args: ["hello"],
    });
    expect(result).toBeOk();
    if (result.isOk()) {
      expect(result.value).toBe(42); // 21 doubled once — not 84
    }
  });

  it("signalWithStart transmits the ORIGINAL workflow and signal args", async () => {
    mockWorkflow.signalWithStart.mockResolvedValue({
      workflowId: "wf-3",
      signaledRunId: "run-1",
    });

    const result = await wireClient.signalWithStart("transformer", {
      workflowId: "wf-3",
      args: "hello",
      signalName: "ping",
      signalArgs: "hey",
    });

    expect(result).toBeOk();
    expect(mockWorkflow.signalWithStart).toHaveBeenCalledWith("transformer", {
      workflowId: "wf-3",
      taskQueue: "wire-q",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      args: ["hello"],
      signal: "ping",
      signalArgs: ["hey"], // original string — not 3
    });
  });

  it("handle.result() parses what the handle returns (receive side)", async () => {
    const rawHandle = {
      workflowId: "wf-4",
      result: vi.fn().mockResolvedValue(21),
      query: vi.fn(),
      signal: vi.fn(),
      executeUpdate: vi.fn(),
    };
    mockWorkflow.getHandle.mockReturnValue(rawHandle);

    const handleResult = wireClient.getHandle("transformer", "wf-4");
    if (!handleResult.isOk()) throw new Error("expected Ok");
    const result = await handleResult.value.result();

    expect(result).toBeOk();
    if (result.isOk()) {
      expect(result.value).toBe(42);
    }
  });

  it("handle.signals.* transmits the ORIGINAL signal args", async () => {
    const rawHandle = {
      workflowId: "wf-5",
      result: vi.fn(),
      query: vi.fn(),
      signal: vi.fn().mockResolvedValue(undefined),
      executeUpdate: vi.fn(),
    };
    mockWorkflow.getHandle.mockReturnValue(rawHandle);

    const handleResult = wireClient.getHandle("transformer", "wf-5");
    if (!handleResult.isOk()) throw new Error("expected Ok");
    const result = await handleResult.value.signals.ping("hey");

    expect(result).toBeOk();
    expect(rawHandle.signal).toHaveBeenCalledWith("ping", "hey");
  });

  it("handle.queries.* transmits the ORIGINAL input and parses the result once", async () => {
    const rawHandle = {
      workflowId: "wf-6",
      result: vi.fn(),
      query: vi.fn().mockResolvedValue(21),
      signal: vi.fn(),
      executeUpdate: vi.fn(),
    };
    mockWorkflow.getHandle.mockReturnValue(rawHandle);

    const handleResult = wireClient.getHandle("transformer", "wf-6");
    if (!handleResult.isOk()) throw new Error("expected Ok");
    const result = await handleResult.value.queries.peek("hey");

    expect(rawHandle.query).toHaveBeenCalledWith("peek", "hey");
    expect(result).toBeOk();
    if (result.isOk()) {
      expect(result.value).toBe(42);
    }
  });

  it("handle.updates.* transmits the ORIGINAL input and parses the result once", async () => {
    const rawHandle = {
      workflowId: "wf-7",
      result: vi.fn(),
      query: vi.fn(),
      signal: vi.fn(),
      executeUpdate: vi.fn().mockResolvedValue(21),
    };
    mockWorkflow.getHandle.mockReturnValue(rawHandle);

    const handleResult = wireClient.getHandle("transformer", "wf-7");
    if (!handleResult.isOk()) throw new Error("expected Ok");
    const result = await handleResult.value.updates.poke("hey");

    expect(rawHandle.executeUpdate).toHaveBeenCalledWith("poke", { args: ["hey"] });
    expect(result).toBeOk();
    if (result.isOk()) {
      expect(result.value).toBe(42);
    }
  });
});

describe("TypedClient — workflow contract errors", () => {
  const erroredContract = defineContract({
    taskQueue: "test-queue",
    workflows: {
      processOrder: defineWorkflow({
        input: z.object({ orderId: z.string() }),
        output: z.object({ status: z.string() }),
        idempotency: "allow-duplicate",
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
    bindContract(erroredContract, {
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

    const result = await (
      await createClient()
    ).executeWorkflow("processOrder", {
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

    const result = await (
      await createClient()
    ).executeWorkflow("processOrder", {
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

    const result = await (
      await createClient()
    ).executeWorkflow("processOrder", {
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

    const handleResult = (await createClient()).getHandle("processOrder", "order-2");
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

describe("ContractClient — handle identifiers and validation-error identity", () => {
  const identityContract = defineContract({
    taskQueue: "identity-q",
    workflows: {
      identityWorkflow: defineWorkflow({
        input: z.object({ id: z.string() }),
        output: z.object({ ok: z.boolean() }),
        idempotency: "allow-duplicate",
      }),
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createClient = () =>
    bindContract(identityContract, {
      workflow: mockWorkflow,
      schedule: mockSchedule,
    } as unknown as Client);

  it("startWorkflow handles carry runId and firstExecutionRunId from the started run", async () => {
    mockWorkflow.start.mockResolvedValue({
      workflowId: "wf-1",
      firstExecutionRunId: "run-first",
    });

    const handleResult = await (
      await createClient()
    ).startWorkflow("identityWorkflow", {
      workflowId: "wf-1",
      args: { id: "a" },
    });

    expect(handleResult).toBeOk();
    if (handleResult.isOk()) {
      expect(handleResult.value.firstExecutionRunId).toBe("run-first");
      expect(handleResult.value.runId).toBe("run-first");
    }
  });

  it("getHandle is synchronous, forwards runId + GetWorkflowHandleOptions, and carries the ids", async () => {
    const rawHandle = { workflowId: "wf-2", result: vi.fn() };
    mockWorkflow.getHandle.mockReturnValue(rawHandle);

    const handleResult = (await createClient()).getHandle("identityWorkflow", "wf-2", {
      runId: "run-9",
      firstExecutionRunId: "run-0",
      followRuns: false,
    });

    expect(handleResult).toBeOk();
    if (handleResult.isOk()) {
      expect(handleResult.value.runId).toBe("run-9");
      expect(handleResult.value.firstExecutionRunId).toBe("run-0");
    }
    expect(mockWorkflow.getHandle).toHaveBeenCalledWith("wf-2", "run-9", {
      firstExecutionRunId: "run-0",
      followRuns: false,
    });
  });

  it("getHandle returns a sync Err(WorkflowNotInContractError) for unknown workflow names", async () => {
    const handleResult = (await createClient()).getHandle(
      "nonExistent" as unknown as "identityWorkflow",
      "wf-3",
    );

    expect(handleResult.isErr()).toBe(true);
    if (handleResult.isErr()) {
      expect(handleResult.error).toBeInstanceOf(WorkflowNotInContractError);
    }
    expect(mockWorkflow.getHandle).not.toHaveBeenCalled();
  });

  it("handle.result() output-validation error carries the workflow NAME and the workflowId", async () => {
    // Regression (v8 review item 12): the workflowId used to be passed as
    // the workflowName constructor argument.
    const rawHandle = {
      workflowId: "wf-4",
      result: vi.fn().mockResolvedValue({ ok: "not-a-boolean" }),
    };
    mockWorkflow.getHandle.mockReturnValue(rawHandle);

    const handleResult = (await createClient()).getHandle("identityWorkflow", "wf-4");
    if (!handleResult.isOk()) throw new Error("expected Ok");
    const result = await handleResult.value.result();

    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(WorkflowValidationError);
      const error = result.error as WorkflowValidationError;
      expect(error.workflowName).toBe("identityWorkflow");
      expect(error.workflowId).toBe("wf-4");
      expect(error.direction).toBe("output");
    }
  });

  it("executeWorkflow validation errors carry the workflowId too", async () => {
    const client = await createClient();

    const inputError = await client.executeWorkflow("identityWorkflow", {
      workflowId: "wf-5",
      args: { id: 42 } as unknown as { id: string },
    });
    expect(inputError).toBeErr();
    if (inputError.isErr()) {
      expect((inputError.error as WorkflowValidationError).workflowId).toBe("wf-5");
      expect((inputError.error as WorkflowValidationError).direction).toBe("input");
    }

    mockWorkflow.execute.mockResolvedValue({ ok: "nope" });
    const outputError = await client.executeWorkflow("identityWorkflow", {
      workflowId: "wf-6",
      args: { id: "a" },
    });
    expect(outputError).toBeErr();
    if (outputError.isErr()) {
      expect((outputError.error as WorkflowValidationError).workflowId).toBe("wf-6");
      expect((outputError.error as WorkflowValidationError).direction).toBe("output");
    }
  });
});

describe("ContractClient — startUpdate", () => {
  const updateContract = defineContract({
    taskQueue: "update-q",
    workflows: {
      updatable: defineWorkflow({
        input: z.object({ id: z.string() }),
        output: z.object({ ok: z.boolean() }),
        idempotency: "allow-duplicate",
        updates: {
          adjust: {
            input: z.object({ delta: z.number() }),
            output: z.number().transform((n) => n * 2),
          },
        },
      }),
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const getUpdatableHandle = async (rawHandle: Record<string, unknown>) => {
    mockWorkflow.getHandle.mockReturnValue(rawHandle);
    const client = await bindContract(updateContract, {
      workflow: mockWorkflow,
      schedule: mockSchedule,
    } as unknown as Client);
    const handleResult = client.getHandle("updatable", "wf-up");
    if (!handleResult.isOk()) throw new Error("expected Ok");
    return handleResult.value;
  };

  it("starts the update with options passthrough and returns a typed update handle", async () => {
    const startUpdate = vi.fn().mockResolvedValue({
      updateId: "upd-1",
      workflowId: "wf-up",
      workflowRunId: "run-1",
      result: vi.fn().mockResolvedValue(21),
    });
    const handle = await getUpdatableHandle({ workflowId: "wf-up", startUpdate });

    const updateHandleResult = await handle.startUpdate("adjust", {
      args: { delta: 3 },
      updateId: "upd-1",
    });

    expect(updateHandleResult).toBeOk();
    expect(startUpdate).toHaveBeenCalledWith("adjust", {
      args: [{ delta: 3 }],
      waitForStage: "ACCEPTED",
      updateId: "upd-1",
    });
    if (updateHandleResult.isOk()) {
      const updateHandle = updateHandleResult.value;
      expect(updateHandle.updateId).toBe("upd-1");
      expect(updateHandle.workflowId).toBe("wf-up");
      expect(updateHandle.workflowRunId).toBe("run-1");

      // result() parses on receive (D1): the transform applies exactly once.
      const result = await updateHandle.result();
      expect(result).toBeOk();
      if (result.isOk()) {
        expect(result.value).toBe(42);
      }
    }
  });

  it("rejects invalid update input before dispatch", async () => {
    const startUpdate = vi.fn();
    const handle = await getUpdatableHandle({ workflowId: "wf-up", startUpdate });

    const updateHandleResult = await handle.startUpdate("adjust", {
      args: { delta: "nope" } as unknown as { delta: number },
    });

    expect(updateHandleResult).toBeErr();
    if (updateHandleResult.isErr()) {
      expect(updateHandleResult.error).toBeInstanceOf(UpdateValidationError);
      expect((updateHandleResult.error as UpdateValidationError).direction).toBe("input");
    }
    expect(startUpdate).not.toHaveBeenCalled();
  });

  it("surfaces WorkflowExecutionNotFoundError when the execution is gone", async () => {
    const startUpdate = vi
      .fn()
      .mockRejectedValue(new TemporalWorkflowNotFoundError("not found", "wf-up", undefined));
    const handle = await getUpdatableHandle({ workflowId: "wf-up", startUpdate });

    const updateHandleResult = await handle.startUpdate("adjust", { args: { delta: 1 } });

    expect(updateHandleResult).toBeErr();
    if (updateHandleResult.isErr()) {
      expect(updateHandleResult.error).toBeInstanceOf(WorkflowExecutionNotFoundError);
    }
  });

  it("routes unrecognized startUpdate failures to the defect channel", async () => {
    const startUpdate = vi.fn().mockRejectedValue(new Error("network down"));
    const handle = await getUpdatableHandle({ workflowId: "wf-up", startUpdate });

    const updateHandleResult = await handle.startUpdate("adjust", { args: { delta: 1 } });

    expect(updateHandleResult).toBeDefect();
    if (updateHandleResult.isDefect()) {
      expect(updateHandleResult.cause).toBeInstanceOf(RuntimeClientError);
      expect((updateHandleResult.cause as RuntimeClientError).operation).toBe("startUpdate");
    }
  });
});

describe("ContractClient — update/query operational errors", () => {
  // Closes the defect-channel hole for routine operational outcomes: a
  // failed/rejected update and an unserveable query are modeled Errs now,
  // not defects.
  const opContract = defineContract({
    taskQueue: "op-q",
    workflows: {
      opWorkflow: defineWorkflow({
        input: z.object({ id: z.string() }),
        output: z.object({ ok: z.boolean() }),
        idempotency: "allow-duplicate",
        queries: {
          peek: { input: z.tuple([]), output: z.string() },
        },
        updates: {
          adjust: { input: z.object({ delta: z.number() }), output: z.number() },
        },
      }),
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const getOpHandle = async (rawHandle: Record<string, unknown>) => {
    mockWorkflow.getHandle.mockReturnValue(rawHandle);
    const client = await bindContract(opContract, {
      workflow: mockWorkflow,
      schedule: mockSchedule,
    } as unknown as Client);
    const handleResult = client.getHandle("opWorkflow", "wf-op");
    if (!handleResult.isOk()) throw new Error("expected Ok");
    return handleResult.value;
  };

  // The wire shape of a worker-side admission rejection: the worker's
  // update-input validator throws an ApplicationFailure whose `type` is
  // pinned to "UpdateInputValidationError".
  const rejectionFailure = () =>
    ApplicationFailure.create({
      type: "UpdateInputValidationError",
      message: 'Update "adjust" input validation failed: at delta: expected number',
      nonRetryable: true,
    });

  it("updates.* classifies a worker-side admission rejection into UpdateRejectedError", async () => {
    const inner = rejectionFailure();
    const executeUpdate = vi
      .fn()
      .mockRejectedValue(new TemporalWorkflowUpdateFailedError("Workflow Update failed", inner));
    const handle = await getOpHandle({ workflowId: "wf-op", executeUpdate });

    const result = await handle.updates.adjust({ delta: 1 });

    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UpdateRejectedError);
      const err = result.error as UpdateRejectedError;
      expect(err.updateName).toBe("adjust");
      // The original ApplicationFailure is kept as cause (wrapper unwrapped).
      expect(err.cause).toBe(inner);
    }
  });

  it("updates.* classifies a failed admitted handler into UpdateFailedError with the inner cause unwrapped", async () => {
    const inner = ApplicationFailure.create({ type: "PaymentDeclined", message: "no funds" });
    const executeUpdate = vi
      .fn()
      .mockRejectedValue(new TemporalWorkflowUpdateFailedError("Workflow Update failed", inner));
    const handle = await getOpHandle({ workflowId: "wf-op", executeUpdate });

    const result = await handle.updates.adjust({ delta: 1 });

    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UpdateFailedError);
      expect(result.error).not.toBeInstanceOf(UpdateRejectedError);
      const err = result.error as UpdateFailedError;
      expect(err.updateName).toBe("adjust");
      expect(err.cause).toBe(inner);
      expect(err.cause).not.toBeInstanceOf(TemporalWorkflowUpdateFailedError);
    }
  });

  it("updates.* still routes unrecognized rejections to the defect channel", async () => {
    const executeUpdate = vi.fn().mockRejectedValue(new Error("grpc blew up"));
    const handle = await getOpHandle({ workflowId: "wf-op", executeUpdate });

    const result = await handle.updates.adjust({ delta: 1 });

    expect(result).toBeDefect();
    if (result.isDefect()) {
      expect(result.cause).toBeInstanceOf(RuntimeClientError);
      expect((result.cause as RuntimeClientError).operation).toBe("update");
    }
  });

  it("startUpdate classifies WorkflowUpdateFailedError (rejection at admission)", async () => {
    const inner = rejectionFailure();
    const startUpdate = vi
      .fn()
      .mockRejectedValue(new TemporalWorkflowUpdateFailedError("Workflow Update failed", inner));
    const handle = await getOpHandle({ workflowId: "wf-op", startUpdate });

    const result = await handle.startUpdate("adjust", { args: { delta: 1 } });

    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UpdateRejectedError);
    }
  });

  it("updateHandle.result() classifies update outcomes too", async () => {
    const inner = ApplicationFailure.create({ type: "SomethingBusiness", message: "boom" });
    const startUpdate = vi.fn().mockResolvedValue({
      updateId: "upd-1",
      workflowId: "wf-op",
      workflowRunId: "run-1",
      result: vi
        .fn()
        .mockRejectedValue(new TemporalWorkflowUpdateFailedError("Workflow Update failed", inner)),
    });
    const handle = await getOpHandle({ workflowId: "wf-op", startUpdate });

    const updateHandleResult = await handle.startUpdate("adjust", { args: { delta: 1 } });
    expect(updateHandleResult).toBeOk();
    if (!updateHandleResult.isOk()) return;

    const result = await updateHandleResult.value.result();
    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UpdateFailedError);
      expect((result.error as UpdateFailedError).cause).toBe(inner);
    }
  });

  it("queries.* classifies QueryNotRegisteredError into QueryFailedError", async () => {
    // Temporal reports BOTH "no handler registered" and "the handler threw"
    // as QueryNotRegisteredError (INVALID_ARGUMENT), so both surface as the
    // modeled QueryFailedError.
    const inner = new TemporalQueryNotRegisteredError(
      "Workflow did not register a handler for peek",
      3,
    );
    const query = vi.fn().mockRejectedValue(inner);
    const handle = await getOpHandle({ workflowId: "wf-op", query });

    const result = await handle.queries.peek([]);

    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(QueryFailedError);
      const err = result.error as QueryFailedError;
      expect(err.queryName).toBe("peek");
      expect(err.cause).toBe(inner);
    }
  });

  it("queries.* still routes unrecognized rejections to the defect channel", async () => {
    const query = vi.fn().mockRejectedValue(new Error("network down"));
    const handle = await getOpHandle({ workflowId: "wf-op", query });

    const result = await handle.queries.peek([]);

    expect(result).toBeDefect();
    if (result.isDefect()) {
      expect(result.cause).toBeInstanceOf(RuntimeClientError);
      expect((result.cause as RuntimeClientError).operation).toBe("query");
    }
  });
});

describe("ContractClient — raw escape hatch and accessors", () => {
  const accessorContract = defineContract({
    taskQueue: "accessor-q",
    workflows: {
      plain: defineWorkflow({
        input: z.object({ id: z.string() }),
        output: z.object({}),
        idempotency: "allow-duplicate",
      }),
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handle.raw exposes the underlying Temporal WorkflowHandle", async () => {
    const rawHandle = { workflowId: "wf-raw", result: vi.fn() };
    mockWorkflow.getHandle.mockReturnValue(rawHandle);
    const client = await bindContract(accessorContract, {
      workflow: mockWorkflow,
      schedule: mockSchedule,
    } as unknown as Client);

    const handleResult = client.getHandle("plain", "wf-raw");
    expect(handleResult).toBeOk();
    if (handleResult.isOk()) {
      expect(handleResult.value.raw).toBe(rawHandle);
    }
  });

  it("startWorkflow handles carry raw too", async () => {
    const rawHandle = { workflowId: "wf-raw-2", firstExecutionRunId: "run-1", result: vi.fn() };
    mockWorkflow.start.mockResolvedValue(rawHandle);
    const client = await bindContract(accessorContract, {
      workflow: mockWorkflow,
      schedule: mockSchedule,
    } as unknown as Client);

    const handleResult = await client.startWorkflow("plain", {
      workflowId: "wf-raw-2",
      args: { id: "a" },
    });
    expect(handleResult).toBeOk();
    if (handleResult.isOk()) {
      expect(handleResult.value.raw).toBe(rawHandle);
    }
  });

  it("exposes the bound contract and its taskQueue for logging/plumbing", async () => {
    const client = await bindContract(accessorContract, {
      workflow: mockWorkflow,
      schedule: mockSchedule,
    } as unknown as Client);

    expect(client.contract).toBe(accessorContract);
    expect(client.taskQueue).toBe("accessor-q");
  });
});

describe("ContractClient — omittable input-less payloads (runtime)", () => {
  // Wave 1 made `defineSignal()` / `defineQuery({output})` /
  // `defineUpdate({output})` materialize an UndefinedInputSchema. The
  // client side: omitted payloads travel as EMPTY args, not `[undefined]`.
  const omittableContract = defineContract({
    taskQueue: "omit-q",
    workflows: {
      omittable: defineWorkflow({
        input: z.object({ id: z.string() }),
        output: z.object({ ok: z.boolean() }),
        idempotency: "allow-duplicate",
        signals: {
          stop: defineSignal(),
        },
        queries: {
          progress: defineQuery({ output: z.number() }),
        },
        updates: {
          refresh: defineUpdate({ output: z.boolean() }),
        },
      }),
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const getOmittableHandle = async (rawHandle: Record<string, unknown>) => {
    mockWorkflow.getHandle.mockReturnValue(rawHandle);
    const client = await bindContract(omittableContract, {
      workflow: mockWorkflow,
      schedule: mockSchedule,
    } as unknown as Client);
    const handleResult = client.getHandle("omittable", "wf-omit");
    if (!handleResult.isOk()) throw new Error("expected Ok");
    return handleResult.value;
  };

  it("payload-less signals send NO payload argument", async () => {
    const signal = vi.fn().mockResolvedValue(undefined);
    const handle = await getOmittableHandle({ workflowId: "wf-omit", signal });

    const result = await handle.signals.stop();

    expect(result).toBeOk();
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith("stop");
  });

  it("argument-less queries send NO payload argument", async () => {
    const query = vi.fn().mockResolvedValue(7);
    const handle = await getOmittableHandle({ workflowId: "wf-omit", query });

    const result = await handle.queries.progress();

    expect(result).toBeOk();
    if (result.isOk()) {
      expect(result.value).toBe(7);
    }
    expect(query).toHaveBeenCalledWith("progress");
  });

  it("argument-less updates send EMPTY args", async () => {
    const executeUpdate = vi.fn().mockResolvedValue(true);
    const handle = await getOmittableHandle({ workflowId: "wf-omit", executeUpdate });

    const result = await handle.updates.refresh();

    expect(result).toBeOk();
    expect(executeUpdate).toHaveBeenCalledWith("refresh", { args: [] });
  });

  it("startUpdate with an omitted options object sends EMPTY args", async () => {
    const startUpdate = vi.fn().mockResolvedValue({
      updateId: "upd-omit",
      workflowId: "wf-omit",
      workflowRunId: undefined,
      result: vi.fn().mockResolvedValue(true),
    });
    const handle = await getOmittableHandle({ workflowId: "wf-omit", startUpdate });

    const result = await handle.startUpdate("refresh");

    expect(result).toBeOk();
    expect(startUpdate).toHaveBeenCalledWith("refresh", {
      args: [],
      waitForStage: "ACCEPTED",
    });
  });

  it("signalWithStart with an omitted signal payload sends EMPTY signalArgs", async () => {
    mockWorkflow.signalWithStart.mockResolvedValue({
      workflowId: "wf-omit",
      signaledRunId: "run-om",
    });
    const client = await bindContract(omittableContract, {
      workflow: mockWorkflow,
      schedule: mockSchedule,
    } as unknown as Client);

    const result = await client.signalWithStart("omittable", {
      workflowId: "wf-omit",
      args: { id: "a" },
      signalName: "stop",
    });

    expect(result).toBeOk();
    expect(mockWorkflow.signalWithStart).toHaveBeenCalledWith("omittable", {
      workflowId: "wf-omit",
      taskQueue: "omit-q",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      args: [{ id: "a" }],
      signal: "stop",
      signalArgs: [],
    });
  });
});

describe("ContractClient — search attribute VALUE validation (runtime)", () => {
  const kindContract = defineContract({
    taskQueue: "kinds-q",
    workflows: {
      kinds: defineWorkflow({
        input: z.object({ id: z.string() }),
        output: z.object({}),
        idempotency: "allow-duplicate",
        searchAttributes: {
          priority: defineSearchAttribute({ kind: "INT" }),
          placedAt: defineSearchAttribute({ kind: "DATETIME" }),
          tags: defineSearchAttribute({ kind: "KEYWORD_LIST" }),
        },
      }),
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts values matching their declared kinds", async () => {
    mockWorkflow.start.mockResolvedValue({ workflowId: "k-2" });
    const client = await bindContract(kindContract, {
      workflow: mockWorkflow,
      schedule: mockSchedule,
    } as unknown as Client);

    const result = await client.startWorkflow("kinds", {
      workflowId: "k-2",
      args: { id: "a" },
      searchAttributes: {
        priority: 3,
        placedAt: new Date("2026-01-01T00:00:00Z"),
        tags: ["a", "b"],
      },
    });

    expect(result).toBeOk();
  });
});

describe("contract-declared idempotency", () => {
  // `onceWorkflow` declares "once-per-id" so its default policy
  // (REJECT_DUPLICATE) is distinguishable from Temporal's own default
  // (ALLOW_DUPLICATE) — a test asserting the wrong/no policy would still
  // pass against the default, so the mode is chosen deliberately.
  const onceWorkflow = defineWorkflow({
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
    idempotency: "once-per-id",
    signals: {
      ping: { input: z.tuple([]) },
    },
  });

  // Simulates a definition that reaches the client without `idempotency` at
  // runtime despite the field now being required at the type level (e.g. a
  // contract assembled dynamically outside the type system, or an older
  // compiled artifact) — the `as unknown as typeof onceWorkflow` cast is the
  // point, not a mistake; it keeps every other generic (notably the `ping`
  // signal's literal name and tuple schema) intact so the calls below stay
  // precisely typed. `client.ts`'s `definition.idempotency ? {
  // workflowIdReusePolicy: … } : {}` guard must stay defensive for exactly
  // this case.
  const plainWorkflow = {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
    signals: {
      ping: { input: z.tuple([]) },
    },
  } as unknown as typeof onceWorkflow;

  const idempotencyContract = defineContract({
    taskQueue: "idempotency-queue",
    workflows: {
      onceWorkflow,
      plainWorkflow,
    },
  });

  let idempotencyClient: ContractClient<typeof idempotencyContract>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const rawClient = { workflow: mockWorkflow, schedule: mockSchedule } as unknown as Client;
    idempotencyClient = await bindContract(idempotencyContract, rawClient);
  });

  it("applies the contract's mode as workflowIdReusePolicy on startWorkflow", async () => {
    mockWorkflow.start.mockResolvedValue({ workflowId: "id-1" });

    await idempotencyClient.startWorkflow("onceWorkflow", {
      workflowId: "id-1",
      args: { id: "a" },
    });

    expect(mockWorkflow.start).toHaveBeenCalledWith("onceWorkflow", {
      workflowId: "id-1",
      taskQueue: "idempotency-queue",
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      args: [{ id: "a" }],
    });
  });

  it("applies it on signalWithStart", async () => {
    mockWorkflow.signalWithStart.mockResolvedValue({
      workflowId: "id-2",
      signaledRunId: "run-1",
    });

    await idempotencyClient.signalWithStart("onceWorkflow", {
      workflowId: "id-2",
      args: { id: "a" },
      signalName: "ping",
      signalArgs: [],
    });

    expect(mockWorkflow.signalWithStart).toHaveBeenCalledWith("onceWorkflow", {
      workflowId: "id-2",
      taskQueue: "idempotency-queue",
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      args: [{ id: "a" }],
      signal: "ping",
      // `signalArgs: []` is the whole args tuple, wrapped once more as the
      // single positional argument Temporal's wire format expects — matches
      // the existing (unrelated to this task) `[[50]]` wrapping behavior
      // exercised elsewhere in this file for a one-arg signal.
      signalArgs: [[]],
    });
  });

  it("applies it on executeWorkflow", async () => {
    mockWorkflow.execute.mockResolvedValue({ ok: true });

    await idempotencyClient.executeWorkflow("onceWorkflow", {
      workflowId: "id-3",
      args: { id: "a" },
    });

    expect(mockWorkflow.execute).toHaveBeenCalledWith("onceWorkflow", {
      workflowId: "id-3",
      taskQueue: "idempotency-queue",
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      args: [{ id: "a" }],
    });
  });

  it("lets an explicit per-call workflowIdReusePolicy override the contract on startWorkflow", async () => {
    // This is the test that catches a contract-after-spread mistake: the
    // three "applies" tests above only prove the field is set to SOMETHING,
    // not that a caller can still win. One instance of this test per start
    // path — precedence is expressed independently at each call site's own
    // spread, so a mistake at one site is invisible to the other two's
    // tests (see the fix-round-1 note in the report for why this matters).
    mockWorkflow.start.mockResolvedValue({ workflowId: "id-4" });

    await idempotencyClient.startWorkflow("onceWorkflow", {
      workflowId: "id-4",
      args: { id: "a" },
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    });

    expect(mockWorkflow.start).toHaveBeenCalledWith("onceWorkflow", {
      workflowId: "id-4",
      taskQueue: "idempotency-queue",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      args: [{ id: "a" }],
    });
  });

  it("lets an explicit per-call workflowIdReusePolicy override the contract on signalWithStart", async () => {
    mockWorkflow.signalWithStart.mockResolvedValue({
      workflowId: "id-4b",
      signaledRunId: "run-4b",
    });

    await idempotencyClient.signalWithStart("onceWorkflow", {
      workflowId: "id-4b",
      args: { id: "a" },
      signalName: "ping",
      signalArgs: [],
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    });

    expect(mockWorkflow.signalWithStart).toHaveBeenCalledWith("onceWorkflow", {
      workflowId: "id-4b",
      taskQueue: "idempotency-queue",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      args: [{ id: "a" }],
      signal: "ping",
      signalArgs: [[]],
    });
  });

  it("lets an explicit per-call workflowIdReusePolicy override the contract on executeWorkflow", async () => {
    mockWorkflow.execute.mockResolvedValue({ ok: true });

    await idempotencyClient.executeWorkflow("onceWorkflow", {
      workflowId: "id-4c",
      args: { id: "a" },
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
    });

    expect(mockWorkflow.execute).toHaveBeenCalledWith("onceWorkflow", {
      workflowId: "id-4c",
      taskQueue: "idempotency-queue",
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      args: [{ id: "a" }],
    });
  });

  it("sends no policy when the contract declares none, on startWorkflow", async () => {
    // `plainWorkflow` is missing `idempotency` at runtime (see its
    // definition above) — no `workflowIdReusePolicy` key at all should be
    // sent (not even `undefined`, which differs under
    // exactOptionalPropertyTypes).
    mockWorkflow.start.mockResolvedValue({ workflowId: "id-5" });

    await idempotencyClient.startWorkflow("plainWorkflow", {
      workflowId: "id-5",
      args: { id: "a" },
    });

    const passed = mockWorkflow.start.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(passed).not.toHaveProperty("workflowIdReusePolicy");
  });

  it("sends no policy when the contract declares none, on signalWithStart", async () => {
    mockWorkflow.signalWithStart.mockResolvedValue({
      workflowId: "id-5b",
      signaledRunId: "run-5b",
    });

    await idempotencyClient.signalWithStart("plainWorkflow", {
      workflowId: "id-5b",
      args: { id: "a" },
      signalName: "ping",
      signalArgs: [],
    });

    const passed = mockWorkflow.signalWithStart.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(passed).not.toHaveProperty("workflowIdReusePolicy");
  });

  it("sends no policy when the contract declares none, on executeWorkflow", async () => {
    mockWorkflow.execute.mockResolvedValue({ ok: true });

    await idempotencyClient.executeWorkflow("plainWorkflow", {
      workflowId: "id-5c",
      args: { id: "a" },
    });

    const passed = mockWorkflow.execute.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(passed).not.toHaveProperty("workflowIdReusePolicy");
  });
});
