/**
 * Coverage for `TypedClient.schedule` — typed wrapper around Temporal's
 * `ScheduleClient`.
 *
 * Closes #181.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isOk, isErr } from "unthrown";
import { z } from "zod";
import type { Client } from "@temporalio/client";
import { TypedSearchAttributes } from "@temporalio/common";
import { defineContract, defineSearchAttribute, defineWorkflow } from "@temporal-contract/contract";
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

  describe("@temporalio/client < 1.16 guard", () => {
    it("throws a clear error when the underlying Client is missing `schedule`", () => {
      // Simulates a consumer who installed @temporalio/client < 1.16
      // (where the Schedule API didn't exist). The peer dep allows all of
      // ^1, so this is a supported install — it just shouldn't crash with a
      // confusing `Cannot read properties of undefined`.
      const oldClient = {
        workflow: { start: vi.fn(), execute: vi.fn(), getHandle: vi.fn() },
        // schedule intentionally absent
      } as unknown as Client;

      expect(() => TypedClient.create(contract, oldClient)).toThrow(
        /requires @temporalio\/client >= 1\.16/,
      );
    });
  });

  describe("create", () => {
    it("validates args, calls Temporal with the contract's taskQueue/workflowType, and returns a typed handle", async () => {
      mockSchedule.create.mockResolvedValue(createMockHandle());

      const result = await client.schedule.create("processOrder", {
        scheduleId: "daily-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        args: { orderId: "sweep" },
      });

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
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

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
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

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
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

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(RuntimeClientError);
        expect((result.error as RuntimeClientError).operation).toBe("schedule.create");
      }
    });

    it("forwards schedule-level options (policies, state, schedule memo)", async () => {
      mockSchedule.create.mockResolvedValue(createMockHandle());

      await client.schedule.create("processOrder", {
        scheduleId: "daily-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        args: { orderId: "sweep" },
        policies: { catchupWindow: "1 minute" },
        state: { paused: true, note: "initial pause" },
        memo: { schedule: "metadata" },
      });

      const passed = mockSchedule.create.mock.calls[0]?.[0];
      expect(passed).toMatchObject({
        policies: { catchupWindow: "1 minute" },
        state: { paused: true, note: "initial pause" },
        memo: { schedule: "metadata" },
      });
    });

    it("forwards workflow-action overrides nested under `action`", async () => {
      mockSchedule.create.mockResolvedValue(createMockHandle());

      await client.schedule.create("processOrder", {
        scheduleId: "daily-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        args: { orderId: "sweep" },
        action: {
          workflowExecutionTimeout: "1 hour",
          retry: { maximumAttempts: 3 },
          memo: { workflow: "metadata" },
        },
      });

      const passed = mockSchedule.create.mock.calls[0]?.[0];
      expect(passed).toMatchObject({
        action: expect.objectContaining({
          workflowExecutionTimeout: "1 hour",
          retry: { maximumAttempts: 3 },
          memo: { workflow: "metadata" },
        }),
      });
    });

    it("schedule-level memo and workflow-action memo can be set independently", async () => {
      // Regression: previously the two `memo`s collided in the flat options
      // shape, making it impossible to set them to different values. With
      // workflow overrides nested under `action`, both flow through cleanly.
      mockSchedule.create.mockResolvedValue(createMockHandle());

      await client.schedule.create("processOrder", {
        scheduleId: "daily-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        args: { orderId: "sweep" },
        memo: { tag: "schedule-level" },
        action: { memo: { tag: "workflow-level" } },
      });

      const passed = mockSchedule.create.mock.calls[0]?.[0];
      expect(passed).toMatchObject({
        memo: { tag: "schedule-level" },
        action: expect.objectContaining({ memo: { tag: "workflow-level" } }),
      });
    });
  });

  describe("create with typed searchAttributes", () => {
    // Schedule-spawned workflows used to silently lose typed search-attribute
    // indexing (caller passed `searchAttributes`, but the schedule create
    // path didn't accept the field). They now flow through the same
    // `toTypedSearchAttributes` translation as direct starts and surface on
    // the underlying `startWorkflow` action.
    const searchContract = defineContract({
      taskQueue: "schedule-search-q",
      workflows: {
        processOrder: defineWorkflow({
          input: z.object({ orderId: z.string() }),
          output: z.object({ status: z.string() }),
          searchAttributes: {
            customerId: defineSearchAttribute({ kind: "KEYWORD" }),
            priority: defineSearchAttribute({ kind: "INT" }),
          },
        }),
      },
    });

    let searchClient: TypedClient<typeof searchContract>;

    beforeEach(() => {
      vi.clearAllMocks();
      const rawClient = {
        workflow: { start: vi.fn(), execute: vi.fn(), getHandle: vi.fn() },
        schedule: mockSchedule,
      } as unknown as Client;
      searchClient = TypedClient.create(searchContract, rawClient);
    });

    it("translates declared searchAttributes into the action's typedSearchAttributes", async () => {
      mockSchedule.create.mockResolvedValue(createMockHandle());

      await searchClient.schedule.create("processOrder", {
        scheduleId: "search-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        args: { orderId: "ORD-1" },
        searchAttributes: { customerId: "CUST-9", priority: 7 },
      });

      const passed = mockSchedule.create.mock.calls[0]?.[0] as {
        action: { typedSearchAttributes?: TypedSearchAttributes };
      };
      expect(passed.action.typedSearchAttributes).toBeInstanceOf(TypedSearchAttributes);
    });

    it("omits typedSearchAttributes from the action when no searchAttributes are provided", async () => {
      mockSchedule.create.mockResolvedValue(createMockHandle());

      await searchClient.schedule.create("processOrder", {
        scheduleId: "search-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        args: { orderId: "ORD-1" },
      });

      const passed = mockSchedule.create.mock.calls[0]?.[0] as {
        action: Record<string, unknown>;
      };
      expect(Object.hasOwn(passed.action, "typedSearchAttributes")).toBe(false);
    });

    it("rejects undeclared attribute keys with a RuntimeClientError", async () => {
      const result = await searchClient.schedule.create("processOrder", {
        scheduleId: "search-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        args: { orderId: "ORD-1" },
        searchAttributes: {
          customerId: "CUST-9",
          // @ts-expect-error — unknownAttr isn't declared on processOrder
          unknownAttr: "ignored",
        },
      });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(RuntimeClientError);
        expect((result.error as RuntimeClientError).operation).toBe("searchAttributes");
        expect((result.error as RuntimeClientError).message).toContain("unknownAttr");
      }
      expect(mockSchedule.create).not.toHaveBeenCalled();
    });
  });

  describe("getHandle + handle methods", () => {
    it("returns a typed handle whose lifecycle methods route to Temporal", async () => {
      const tempHandle = createMockHandle();
      mockSchedule.getHandle.mockReturnValue(tempHandle);

      const handle = client.schedule.getHandle("daily-sweep");
      expect(handle.scheduleId).toBe("daily-sweep");

      expect((await handle.pause("test")).isOk()).toBe(true);
      expect(tempHandle.pause).toHaveBeenCalledWith("test");

      expect((await handle.unpause()).isOk()).toBe(true);
      expect(tempHandle.unpause).toHaveBeenCalled();

      expect((await handle.trigger()).isOk()).toBe(true);
      expect(tempHandle.trigger).toHaveBeenCalled();

      expect((await handle.delete()).isOk()).toBe(true);
      expect(tempHandle.delete).toHaveBeenCalled();
    });

    it("wraps Temporal errors as RuntimeClientError tagged by the failing operation", async () => {
      const tempHandle = createMockHandle();
      tempHandle.pause.mockRejectedValue(new Error("not found"));
      mockSchedule.getHandle.mockReturnValue(tempHandle);

      const handle = client.schedule.getHandle("missing");
      const result = await handle.pause();
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
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

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect((result.value as { scheduleId: string }).scheduleId).toBe("daily-sweep");
      }
    });
  });
});
