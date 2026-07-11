import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";
import type { ContractDefinition } from "@temporal-contract/contract";
import { createWorker, createWorkerOrThrow, workflowsPathFromURL } from "./worker.js";
import { NativeConnection, Worker } from "@temporalio/worker";

// Mock @temporalio/worker
vi.mock("@temporalio/worker", () => ({
  NativeConnection: {
    connect: vi.fn(),
  },
  Worker: {
    create: vi.fn(),
  },
}));

describe("Worker Entry Point", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createWorker", () => {
    it("should create a worker with contract task queue", async () => {
      // GIVEN
      const contract = {
        taskQueue: "test-queue",
        workflows: {
          testWorkflow: {
            input: z.object({ value: z.string() }),
            output: z.object({ result: z.string() }),
          },
        },
      } satisfies ContractDefinition;

      const mockConnection = { close: vi.fn() } as unknown as NativeConnection;
      const mockWorker = { run: vi.fn() } as unknown as Worker;

      vi.mocked(Worker.create).mockResolvedValue(mockWorker);

      // WHEN
      const workerResult = await createWorker({
        contract,
        connection: mockConnection,
        workflowsPath: "/path/to/workflows",
        activities: {},
      });

      // THEN
      expect(Worker.create).toHaveBeenCalledWith({
        connection: mockConnection,
        taskQueue: "test-queue",
        workflowsPath: "/path/to/workflows",
        activities: {},
      });
      expect(workerResult).toBeOkWith(mockWorker);
    });

    it("should surface Worker.create rejections as Err(TechnicalError)", async () => {
      // GIVEN
      const contract = {
        taskQueue: "test-queue",
        workflows: {
          testWorkflow: {
            input: z.object({ value: z.string() }),
            output: z.object({ result: z.string() }),
          },
        },
      } satisfies ContractDefinition;
      const bundleError = new Error("failed to bundle workflows");
      vi.mocked(Worker.create).mockRejectedValue(bundleError);

      // WHEN
      const workerResult = await createWorker({
        contract,
        connection: { close: vi.fn() } as unknown as NativeConnection,
        workflowsPath: "/path/to/workflows",
        activities: {},
      });

      // THEN — modeled on the Err channel, not thrown
      expect(workerResult).toBeErr();
      if (workerResult.isErr()) {
        expect(workerResult.error._tag).toBe("@temporal-contract/TechnicalError");
        expect(workerResult.error.message).toContain('task queue "test-queue"');
        expect(workerResult.error.cause).toBe(bundleError);
      }
    });

    it("createWorkerOrThrow keeps the throwing shape (deprecated alias)", async () => {
      // GIVEN
      const contract = {
        taskQueue: "test-queue",
        workflows: {
          testWorkflow: {
            input: z.object({ value: z.string() }),
            output: z.object({ result: z.string() }),
          },
        },
      } satisfies ContractDefinition;
      const bundleError = new Error("failed to bundle workflows");
      vi.mocked(Worker.create).mockRejectedValue(bundleError);

      // WHEN / THEN — the original cause is rethrown, not the wrapper
      await expect(
        createWorkerOrThrow({
          contract,
          connection: { close: vi.fn() } as unknown as NativeConnection,
          workflowsPath: "/path/to/workflows",
          activities: {},
        }),
      ).rejects.toBe(bundleError);
    });

    it("should use provided connection", async () => {
      // GIVEN
      const contract = {
        taskQueue: "my-queue",
        workflows: {
          testWorkflow: {
            input: z.object({ value: z.string() }),
            output: z.object({ result: z.string() }),
          },
        },
      } satisfies ContractDefinition;

      const existingConnection = { close: vi.fn() } as unknown as NativeConnection;
      const mockWorker = { run: vi.fn() } as unknown as Worker;

      vi.mocked(Worker.create).mockResolvedValue(mockWorker);

      // WHEN
      const workerResult = await createWorker({
        contract,
        connection: existingConnection,
        workflowsPath: "/path/to/workflows",
        activities: {},
      });

      // THEN
      expect(Worker.create).toHaveBeenCalledWith({
        connection: existingConnection,
        taskQueue: "my-queue",
        workflowsPath: "/path/to/workflows",
        activities: {},
      });
      expect(workerResult).toBeOkWith(mockWorker);
    });

    it("should pass through other worker options", async () => {
      // GIVEN
      const contract = {
        taskQueue: "test-queue",
        workflows: {
          testWorkflow: {
            input: z.object({ value: z.string() }),
            output: z.object({ result: z.string() }),
          },
        },
      } satisfies ContractDefinition;

      const mockConnection = { close: vi.fn() } as unknown as NativeConnection;
      const mockWorker = { run: vi.fn() } as unknown as Worker;

      vi.mocked(Worker.create).mockResolvedValue(mockWorker);

      // WHEN
      await createWorker({
        contract,
        connection: mockConnection,
        workflowsPath: "/path/to/workflows",
        activities: {},
        namespace: "custom-namespace",
      });

      // THEN
      expect(Worker.create).toHaveBeenCalledWith({
        connection: mockConnection,
        taskQueue: "test-queue",
        workflowsPath: "/path/to/workflows",
        activities: {},
        namespace: "custom-namespace",
      });
    });
  });

  describe("workflowsPathFromURL", () => {
    it("should resolve a relative .js path against the base URL", () => {
      // GIVEN
      const baseURL = "file:///home/user/project/worker.js";
      const relativePath = "./workflows.js";

      // WHEN
      const result = workflowsPathFromURL(baseURL, relativePath);

      // THEN
      expect(result).toContain("workflows");
      expect(result).toContain(".js");
    });

    it("should resolve a relative .ts path against the base URL", () => {
      // GIVEN
      const baseURL = "file:///home/user/project/worker.ts";
      const relativePath = "./workflows.ts";

      // WHEN
      const result = workflowsPathFromURL(baseURL, relativePath);

      // THEN
      expect(result).toContain("workflows");
      expect(result).toContain(".ts");
    });

    it("should resolve path without extension when caller omits it", () => {
      // GIVEN
      const baseURL = "file:///home/user/project/worker.js";
      const relativePath = "./workflows";

      // WHEN
      const result = workflowsPathFromURL(baseURL, relativePath);

      // THEN
      expect(result).toBe("/home/user/project/workflows");
    });
  });
});
