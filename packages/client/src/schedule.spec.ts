/**
 * Coverage for `TypedClient.schedule` — typed wrapper around Temporal's
 * `ScheduleClient`.
 *
 * Closes #181.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Client } from "@temporalio/client";
import { defineContract } from "@temporal-contract/contract";
import { TypedClient } from "./client.js";
import { RuntimeClientError, WorkflowNotFoundError, WorkflowValidationError } from "./errors.js";

const createMockHandle = () => ({
  scheduleId: "daily-sweep",
  pause: vi.fn().mockResolvedValue(undefined),
  unpause: vi.fn().mockResolvedValue(undefined),
  trigger: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  describe: vi.fn().mockResolvedValue({ scheduleId: "daily-sweep" }),
  update: vi.fn(),
  backfill: vi.fn(),
  readme: vi.fn(),
});

const mockSchedule = {
  create: vi.fn(),
  getHandle: vi.fn(),
  list: vi.fn(),
};

vi.mock("@temporalio/client", () => ({
  WorkflowHandle: vi.fn(),
}));

describe("TypedClient.schedule", () => {
  const contract = defineContract({
    taskQueue: "schedules-q",
    workflows: {
      processOrder: {
        input: z.object({ orderId: z.string() }),
        output: z.object({ status: z.string() }),
      },
    },
  });

  let client: TypedClient<typeof contract>;

  beforeEach(() => {
    vi.clearAllMocks();
    const rawClient = {
      workflow: { start: vi.fn(), execute: vi.fn(), getHandle: vi.fn() },
      schedule: mockSchedule,
    } as unknown as Client;
    client = TypedClient.create(contract, rawClient);
  });

  describe("create", () => {
    it("validates args, calls Temporal with the contract's taskQueue/workflowType, and returns a typed handle", async () => {
      mockSchedule.create.mockResolvedValue(createMockHandle());

      const result = await client.schedule.create("processOrder", {
        scheduleId: "daily-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        args: { orderId: "sweep" },
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.scheduleId).toBe("daily-sweep");
      }

      expect(mockSchedule.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduleId: "daily-sweep",
          spec: { cronExpressions: ["0 2 * * *"] },
          action: expect.objectContaining({
            type: "startWorkflow",
            workflowType: "processOrder",
            taskQueue: "schedules-q",
            args: [{ orderId: "sweep" }],
          }),
        }),
      );
    });

    it("returns WorkflowNotFoundError when the workflow isn't declared", async () => {
      const result = await client.schedule.create(
        // @ts-expect-error testing runtime validation
        "nonExistent",
        {
          scheduleId: "daily-sweep",
          spec: { cronExpressions: ["0 2 * * *"] },
          args: { orderId: "sweep" },
        },
      );

      expect(result.isError()).toBe(true);
      if (result.isError()) {
        expect(result.error).toBeInstanceOf(WorkflowNotFoundError);
      }
      expect(mockSchedule.create).not.toHaveBeenCalled();
    });

    it("returns WorkflowValidationError when args fail input-schema validation", async () => {
      const result = await client.schedule.create("processOrder", {
        scheduleId: "daily-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        // @ts-expect-error testing runtime validation
        args: { orderId: 123 },
      });

      expect(result.isError()).toBe(true);
      if (result.isError()) {
        expect(result.error).toBeInstanceOf(WorkflowValidationError);
      }
      expect(mockSchedule.create).not.toHaveBeenCalled();
    });

    it("returns RuntimeClientError when Temporal's create rejects", async () => {
      mockSchedule.create.mockRejectedValue(new Error("temporal down"));

      const result = await client.schedule.create("processOrder", {
        scheduleId: "daily-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        args: { orderId: "sweep" },
      });

      expect(result.isError()).toBe(true);
      if (result.isError()) {
        expect(result.error).toBeInstanceOf(RuntimeClientError);
        expect((result.error as RuntimeClientError).operation).toBe("schedule.create");
      }
    });

    it("forwards optional Temporal options (policies, state, retry, etc.)", async () => {
      mockSchedule.create.mockResolvedValue(createMockHandle());

      await client.schedule.create("processOrder", {
        scheduleId: "daily-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        args: { orderId: "sweep" },
        policies: { catchupWindow: "1 minute" },
        state: { paused: true, note: "initial pause" },
        memo: { tag: "demo" },
        workflowExecutionTimeout: "1 hour",
        retry: { maximumAttempts: 3 },
      });

      const passed = mockSchedule.create.mock.calls[0]?.[0];
      expect(passed).toMatchObject({
        policies: { catchupWindow: "1 minute" },
        state: { paused: true, note: "initial pause" },
        memo: { tag: "demo" },
        action: expect.objectContaining({
          workflowExecutionTimeout: "1 hour",
          retry: { maximumAttempts: 3 },
        }),
      });
    });
  });

  describe("getHandle + handle methods", () => {
    it("returns a typed handle whose lifecycle methods route to Temporal", async () => {
      const tempHandle = createMockHandle();
      mockSchedule.getHandle.mockReturnValue(tempHandle);

      const handle = client.schedule.getHandle("daily-sweep");
      expect(handle.scheduleId).toBe("daily-sweep");

      await expect(handle.pause("test")).resolves.toEqual(expect.objectContaining({ tag: "Ok" }));
      expect(tempHandle.pause).toHaveBeenCalledWith("test");

      await expect(handle.unpause()).resolves.toEqual(expect.objectContaining({ tag: "Ok" }));
      expect(tempHandle.unpause).toHaveBeenCalled();

      await expect(handle.trigger()).resolves.toEqual(expect.objectContaining({ tag: "Ok" }));
      expect(tempHandle.trigger).toHaveBeenCalled();

      await expect(handle.delete()).resolves.toEqual(expect.objectContaining({ tag: "Ok" }));
      expect(tempHandle.delete).toHaveBeenCalled();
    });

    it("wraps Temporal errors as RuntimeClientError tagged by the failing operation", async () => {
      const tempHandle = createMockHandle();
      tempHandle.pause.mockRejectedValue(new Error("not found"));
      mockSchedule.getHandle.mockReturnValue(tempHandle);

      const handle = client.schedule.getHandle("missing");
      const result = await handle.pause();
      expect(result.isError()).toBe(true);
      if (result.isError()) {
        expect(result.error).toBeInstanceOf(RuntimeClientError);
        expect((result.error as RuntimeClientError).operation).toBe("schedule.pause");
      }
    });

    it("describe returns the schedule description in the Ok branch", async () => {
      const tempHandle = createMockHandle();
      tempHandle.describe.mockResolvedValue({ scheduleId: "daily-sweep", spec: {} });
      mockSchedule.getHandle.mockReturnValue(tempHandle);

      const handle = client.schedule.getHandle("daily-sweep");
      const result = await handle.describe();

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect((result.value as { scheduleId: string }).scheduleId).toBe("daily-sweep");
      }
    });
  });
});
