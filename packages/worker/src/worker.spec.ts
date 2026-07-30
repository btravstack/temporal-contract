import type { ContractDefinition } from "@temporal-contract/contract";
import { type NativeConnection, Worker } from "@temporalio/worker";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";

import { TypedWorker, TechnicalError, workflowsPathFromURL } from "./worker.js";

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

  describe("TypedWorker.create", () => {
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
      const workerResult = await TypedWorker.create({
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
      expect(workerResult).toBeOk();
      if (workerResult.isOk()) {
        expect(workerResult.value).toBeInstanceOf(TypedWorker);
        // The underlying Temporal Worker stays reachable via the escape hatch.
        expect(workerResult.value.raw).toBe(mockWorker);
      }
    });

    it("should surface Worker.create rejections as a Defect with a TechnicalError cause", async () => {
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
      const workerResult = await TypedWorker.create({
        contract,
        connection: { close: vi.fn() } as unknown as NativeConnection,
        workflowsPath: "/path/to/workflows",
        activities: {},
      });

      // THEN — a technical fault rides the defect channel (a TechnicalError
      // instance as the cause), not the modeled Err channel
      expect(workerResult).toBeDefect();
      if (workerResult.isDefect()) {
        const cause = workerResult.cause;
        expect(cause).toBeInstanceOf(TechnicalError);
        expect((cause as TechnicalError)._tag).toBe("@temporal-contract/TechnicalError");
        expect((cause as TechnicalError).message).toContain('task queue "test-queue"');
        expect((cause as TechnicalError).cause).toBe(bundleError);
      }
    });

    it("supports workflow-only workers: omitting `activities` omits the key entirely", async () => {
      // GIVEN — a deployment where activities run on a separate worker
      // process; this one only executes workflows.
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

      // WHEN — no `activities` in the options
      const workerResult = await TypedWorker.create({
        contract,
        connection: mockConnection,
        workflowsPath: "/path/to/workflows",
      });

      // THEN — Worker.create is called WITHOUT an `activities` key (not with
      // `activities: undefined` — exactOptionalPropertyTypes discipline).
      expect(Worker.create).toHaveBeenCalledWith({
        connection: mockConnection,
        taskQueue: "test-queue",
        workflowsPath: "/path/to/workflows",
      });
      const callArg = vi.mocked(Worker.create).mock.calls[0]![0];
      expect(Object.keys(callArg)).not.toContain("activities");
      expect(workerResult).toBeOk();
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
      const workerResult = await TypedWorker.create({
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
      expect(workerResult).toBeOk();
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
      await TypedWorker.create({
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

  describe("TypedWorker lifecycle", () => {
    const contract = {
      taskQueue: "lifecycle-queue",
      workflows: {
        testWorkflow: {
          input: z.object({ value: z.string() }),
          output: z.object({ result: z.string() }),
        },
      },
    } satisfies ContractDefinition;

    async function createTypedWorker(rawWorker: Worker): Promise<TypedWorker> {
      vi.mocked(Worker.create).mockResolvedValue(rawWorker);
      return await TypedWorker.create({
        contract,
        connection: { close: vi.fn() } as unknown as NativeConnection,
        workflowsPath: "/path/to/workflows",
        activities: {},
      }).get();
    }

    it("run() resolves Ok(void) when the underlying run completes", async () => {
      // GIVEN
      const rawWorker = { run: vi.fn().mockResolvedValue(undefined) } as unknown as Worker;
      const worker = await createTypedWorker(rawWorker);

      // WHEN
      const runResult = await worker.run();

      // THEN
      expect(rawWorker.run).toHaveBeenCalledTimes(1);
      expect(runResult).toBeOk();
    });

    it("run() surfaces a runtime failure as a Defect with a TechnicalError cause", async () => {
      // GIVEN
      const runError = new Error("poller crashed");
      const rawWorker = { run: vi.fn().mockRejectedValue(runError) } as unknown as Worker;
      const worker = await createTypedWorker(rawWorker);

      // WHEN
      const runResult = await worker.run();

      // THEN — a running-worker failure is a technical fault on the defect
      // channel, never a modeled Err
      expect(runResult).toBeDefect();
      if (runResult.isDefect()) {
        const cause = runResult.cause;
        expect(cause).toBeInstanceOf(TechnicalError);
        expect((cause as TechnicalError).message).toContain('task queue "lifecycle-queue"');
        expect((cause as TechnicalError).cause).toBe(runError);
      }
    });

    it("run() folds a synchronous throw from the underlying run into the defect channel", async () => {
      // GIVEN — Temporal throws IllegalStateError synchronously on a double run
      const stateError = new Error("Poller was already started");
      const rawWorker = {
        run: vi.fn(() => {
          throw stateError;
        }),
      } as unknown as Worker;
      const worker = await createTypedWorker(rawWorker);

      // WHEN — calling run() must not throw
      const runResult = await worker.run();

      // THEN
      expect(runResult).toBeDefect();
      if (runResult.isDefect()) {
        expect((runResult.cause as TechnicalError).cause).toBe(stateError);
      }
    });

    it("shutdown() delegates to the underlying worker", async () => {
      // GIVEN
      const rawWorker = { run: vi.fn(), shutdown: vi.fn() } as unknown as Worker;
      const worker = await createTypedWorker(rawWorker);

      // WHEN
      worker.shutdown();

      // THEN
      expect(rawWorker.shutdown).toHaveBeenCalledTimes(1);
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
