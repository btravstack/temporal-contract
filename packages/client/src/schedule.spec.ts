import { defineContract, defineSearchAttribute, defineWorkflow } from "@temporal-contract/contract";
import type { Client } from "@temporalio/client";
import { TypedSearchAttributes } from "@temporalio/common";
/**
 * Coverage for `TypedClient.schedule` — typed wrapper around Temporal's
 * `ScheduleClient`.
 *
 * Closes #181.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { type ContractClient, TypedClient } from "./client.js";
import {
  RuntimeClientError,
  ScheduleAlreadyExistsError,
  ScheduleNotFoundError,
  WorkflowNotInContractError,
  WorkflowValidationError,
} from "./errors.js";

/**
 * Test construction helper: build the connection-scoped root and bind the
 * contract in one step (`create`'s Err channel is `never`, so `.get()`
 * unwraps directly).
 */
async function bindContract<TContract extends Parameters<TypedClient["for"]>[0]>(
  contract: TContract,
  rawClient: Client,
): Promise<ContractClient<TContract>> {
  return (await TypedClient.create({ client: rawClient })).get().for(contract);
}

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

// Constructable stand-ins for the Temporal error classes the typed client
// discriminates with `instanceof` (see client.spec.ts for the rationale).
vi.mock("@temporalio/client", () => {
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
  class WorkflowExecutionAlreadyStartedError extends Error {}
  class WorkflowFailedError extends Error {}
  return {
    WorkflowHandle: vi.fn(),
    ScheduleAlreadyRunning,
    ScheduleNotFoundError,
    WorkflowExecutionAlreadyStartedError,
    WorkflowFailedError,
  };
});

// Import AFTER the mock declaration so the stand-in classes are used both
// here (to construct rejection values) and inside the classify helpers.
const {
  ScheduleAlreadyRunning: MockScheduleAlreadyRunning,
  ScheduleNotFoundError: MockTemporalScheduleNotFoundError,
} = await import("@temporalio/client");

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

  let client: ContractClient<typeof contract>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const rawClient = {
      workflow: { start: vi.fn(), execute: vi.fn(), getHandle: vi.fn() },
      schedule: mockSchedule,
    } as unknown as Client;
    client = await bindContract(contract, rawClient);
  });

  describe("@temporalio/client < 1.16 guard", () => {
    it("TypedClient.create surfaces a missing `schedule` as a Defect with a clear message", async () => {
      // Simulates a consumer who installed @temporalio/client < 1.16
      // (where the Schedule API didn't exist). The peer dep allows all of
      // ^1, so this is a supported install — it just shouldn't crash with a
      // confusing `Cannot read properties of undefined`. The check lives on
      // the connection-scoped root (it's a property of the client, not of
      // any contract).
      const oldClient = {
        workflow: { start: vi.fn(), execute: vi.fn(), getHandle: vi.fn() },
        // schedule intentionally absent
      } as unknown as Client;

      const created = await TypedClient.create({ client: oldClient });
      expect(created).toBeDefect();
      if (created.isDefect()) {
        expect((created.cause as Error).message).toMatch(/requires @temporalio\/client >= 1\.16/);
      }
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

      expect(result).toBeOk();
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

    it("transmits the ORIGINAL args, not the parsed value (D1 wire format)", async () => {
      // Sender validates and discards the parsed result; the worker parses
      // on receive. A transforming input schema makes the difference visible.
      const transformContract = defineContract({
        taskQueue: "schedules-q",
        workflows: {
          transformer: defineWorkflow({
            input: z.string().transform((s) => s.length),
            output: z.number(),
          }),
        },
      });
      const rawClient = {
        workflow: { start: vi.fn(), execute: vi.fn(), getHandle: vi.fn() },
        schedule: mockSchedule,
      } as unknown as Client;
      const transformClient = await bindContract(transformContract, rawClient);
      mockSchedule.create.mockResolvedValue(createMockHandle());

      const result = await transformClient.schedule.create("transformer", {
        scheduleId: "transform-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        args: "hello",
      });

      expect(result).toBeOk();
      expect(mockSchedule.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: expect.objectContaining({
            args: ["hello"], // original string — not 5 (the parsed length)
          }),
        }),
      );
    });

    it("returns WorkflowNotInContractError when the workflow isn't declared", async () => {
      const result = await client.schedule.create(
        // @ts-expect-error testing runtime validation
        "nonExistent",
        {
          scheduleId: "daily-sweep",
          spec: { cronExpressions: ["0 2 * * *"] },
          args: { orderId: "sweep" },
        },
      );

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowNotInContractError);
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

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowValidationError);
      }
      expect(mockSchedule.create).not.toHaveBeenCalled();
    });

    it("surfaces a Defect(RuntimeClientError) when Temporal's create rejects", async () => {
      mockSchedule.create.mockRejectedValue(new Error("temporal down"));

      const result = await client.schedule.create("processOrder", {
        scheduleId: "daily-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        args: { orderId: "sweep" },
      });

      expect(result).toBeDefect();
      if (result.isDefect()) {
        expect(result.cause).toBeInstanceOf(RuntimeClientError);
        expect((result.cause as RuntimeClientError).operation).toBe("schedule.create");
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

    let searchClient: ContractClient<typeof searchContract>;

    beforeEach(async () => {
      vi.clearAllMocks();
      const rawClient = {
        workflow: { start: vi.fn(), execute: vi.fn(), getHandle: vi.fn() },
        schedule: mockSchedule,
      } as unknown as Client;
      searchClient = await bindContract(searchContract, rawClient);
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

    it("rejects undeclared attribute keys with a Defect(RuntimeClientError)", async () => {
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

      expect(result).toBeDefect();
      if (result.isDefect()) {
        expect(result.cause).toBeInstanceOf(RuntimeClientError);
        expect((result.cause as RuntimeClientError).operation).toBe("searchAttributes");
        expect((result.cause as RuntimeClientError).message).toContain("unknownAttr");
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

      expect(await handle.pause("test")).toBeOk();
      expect(tempHandle.pause).toHaveBeenCalledWith("test");

      expect(await handle.unpause()).toBeOk();
      expect(tempHandle.unpause).toHaveBeenCalled();

      expect(await handle.trigger()).toBeOk();
      expect(tempHandle.trigger).toHaveBeenCalled();

      expect(await handle.delete()).toBeOk();
      expect(tempHandle.delete).toHaveBeenCalled();
    });

    it("wraps Temporal errors as a Defect(RuntimeClientError) tagged by the failing operation", async () => {
      const tempHandle = createMockHandle();
      tempHandle.pause.mockRejectedValue(new Error("not found"));
      mockSchedule.getHandle.mockReturnValue(tempHandle);

      const handle = client.schedule.getHandle("missing");
      const result = await handle.pause();
      expect(result).toBeDefect();
      if (result.isDefect()) {
        expect(result.cause).toBeInstanceOf(RuntimeClientError);
        expect((result.cause as RuntimeClientError).operation).toBe("schedule.pause");
      }
    });

    it("describe returns the schedule description in the Ok branch", async () => {
      const tempHandle = createMockHandle();
      tempHandle.describe.mockResolvedValue({ scheduleId: "daily-sweep", spec: {} });
      mockSchedule.getHandle.mockReturnValue(tempHandle);

      const handle = client.schedule.getHandle("daily-sweep");
      const result = await handle.describe();

      expect(result).toBeOk();
      if (result.isOk()) {
        expect((result.value as { scheduleId: string }).scheduleId).toBe("daily-sweep");
      }
    });

    it("update fetches the description, applies updateFn once, and persists the computed options", async () => {
      const tempHandle = createMockHandle();
      tempHandle.update.mockResolvedValue(undefined);
      tempHandle.describe.mockResolvedValue({ scheduleId: "daily-sweep", spec: { intervals: [] } });
      mockSchedule.getHandle.mockReturnValue(tempHandle);

      const handle = client.schedule.getHandle("daily-sweep");
      const updateFn = vi.fn((previous: { spec?: unknown }) => ({ spec: previous.spec ?? {} }));
      const result = await handle.update(updateFn as never);

      expect(result).toBeOk();
      // The wrapper fetches the description itself (so it can async-validate
      // before anything persists) and hands Temporal a thunk returning the
      // already-computed options — updateFn runs exactly once.
      expect(tempHandle.describe).toHaveBeenCalledTimes(1);
      expect(updateFn).toHaveBeenCalledTimes(1);
      expect(updateFn).toHaveBeenCalledWith({ scheduleId: "daily-sweep", spec: { intervals: [] } });
      expect(tempHandle.update).toHaveBeenCalledTimes(1);
      const persistFn = tempHandle.update.mock.calls[0]?.[0] as (previous: unknown) => unknown;
      expect(persistFn({})).toEqual({ spec: { intervals: [] } });
    });

    it("update validates args against the contract when the action targets a declared workflow", async () => {
      const tempHandle = createMockHandle();
      tempHandle.update.mockResolvedValue(undefined);
      mockSchedule.getHandle.mockReturnValue(tempHandle);

      const handle = client.schedule.getHandle("daily-sweep");
      const result = await handle.update((() => ({
        spec: {},
        action: {
          type: "startWorkflow",
          workflowType: "processOrder",
          taskQueue: "schedules-q",
          // orderId must be a string — this must be rejected.
          args: [{ orderId: 123 }],
        },
      })) as never);

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WorkflowValidationError);
        const error = result.error as WorkflowValidationError;
        expect(error.workflowName).toBe("processOrder");
        expect(error.direction).toBe("input");
      }
      // Nothing persisted on a validation failure.
      expect(tempHandle.update).not.toHaveBeenCalled();
    });

    it("update accepts valid args for a declared workflow and persists them unchanged", async () => {
      const tempHandle = createMockHandle();
      tempHandle.update.mockResolvedValue(undefined);
      mockSchedule.getHandle.mockReturnValue(tempHandle);

      const updated = {
        spec: {},
        action: {
          type: "startWorkflow",
          workflowType: "processOrder",
          taskQueue: "schedules-q",
          args: [{ orderId: "sweep-2" }],
        },
      };
      const handle = client.schedule.getHandle("daily-sweep");
      const result = await handle.update((() => updated) as never);

      expect(result).toBeOk();
      const persistFn = tempHandle.update.mock.calls[0]?.[0] as (previous: unknown) => unknown;
      // Original args on the wire — validated, not transformed (D1).
      expect(persistFn({})).toBe(updated);
    });

    it("update passes through actions whose workflowType isn't declared on the contract", async () => {
      // Documented passthrough: the contract has no schema to check an
      // undeclared workflowType against, so the options persist as-is.
      const tempHandle = createMockHandle();
      tempHandle.update.mockResolvedValue(undefined);
      mockSchedule.getHandle.mockReturnValue(tempHandle);

      const handle = client.schedule.getHandle("daily-sweep");
      const result = await handle.update((() => ({
        spec: {},
        action: {
          type: "startWorkflow",
          workflowType: "someForeignWorkflow",
          taskQueue: "other-q",
          args: [{ anything: true }],
        },
      })) as never);

      expect(result).toBeOk();
      expect(tempHandle.update).toHaveBeenCalledTimes(1);
    });

    it("update surfaces ScheduleNotFoundError when the describe phase hits a missing schedule", async () => {
      const tempHandle = { ...createMockHandle(), scheduleId: "missing" };
      tempHandle.describe.mockRejectedValue(
        new MockTemporalScheduleNotFoundError("not found", "missing"),
      );
      mockSchedule.getHandle.mockReturnValue(tempHandle);

      const handle = client.schedule.getHandle("missing");
      const result = await handle.update(((previous: unknown) => previous) as never);

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ScheduleNotFoundError);
      }
      expect(tempHandle.update).not.toHaveBeenCalled();
    });

    it("routes backfill through Temporal's ScheduleHandle.backfill", async () => {
      const tempHandle = createMockHandle();
      tempHandle.backfill.mockResolvedValue(undefined);
      mockSchedule.getHandle.mockReturnValue(tempHandle);

      const handle = client.schedule.getHandle("daily-sweep");
      const range = {
        start: new Date("2026-01-01T00:00:00Z"),
        end: new Date("2026-01-02T00:00:00Z"),
      };
      const result = await handle.backfill(range);

      expect(result).toBeOk();
      expect(tempHandle.backfill).toHaveBeenCalledWith(range);
    });
  });

  describe("typed schedule errors (parity with the workflow side)", () => {
    it("create surfaces ScheduleAlreadyExistsError on Temporal's ScheduleAlreadyRunning", async () => {
      mockSchedule.create.mockRejectedValue(
        new MockScheduleAlreadyRunning("already running", "daily-sweep"),
      );

      const result = await client.schedule.create("processOrder", {
        scheduleId: "daily-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        args: { orderId: "sweep" },
      });

      expect(result).toBeErr();
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(ScheduleAlreadyExistsError);
        const error = result.error as ScheduleAlreadyExistsError;
        expect(error.scheduleId).toBe("daily-sweep");
        expect(error.cause).toBeInstanceOf(MockScheduleAlreadyRunning);
      }
    });

    it("handle methods surface ScheduleNotFoundError on Temporal's ScheduleNotFoundError", async () => {
      const tempHandle = { ...createMockHandle(), scheduleId: "missing" };
      tempHandle.pause.mockRejectedValue(
        new MockTemporalScheduleNotFoundError("not found", "missing"),
      );
      tempHandle.delete.mockRejectedValue(new MockTemporalScheduleNotFoundError("not found", ""));
      mockSchedule.getHandle.mockReturnValue(tempHandle);

      const handle = client.schedule.getHandle("missing");

      const paused = await handle.pause();
      expect(paused).toBeErr();
      if (paused.isErr()) {
        expect(paused.error).toBeInstanceOf(ScheduleNotFoundError);
        expect((paused.error as ScheduleNotFoundError).scheduleId).toBe("missing");
      }

      // Temporal normalizes a missing ID to the empty string; the handle's
      // own scheduleId is the fallback so the error stays identifying.
      const deleted = await handle.delete();
      expect(deleted).toBeErr();
      if (deleted.isErr()) {
        expect((deleted.error as ScheduleNotFoundError).scheduleId).toBe("missing");
      }
    });

    it("unrecognized create failures still ride the defect channel", async () => {
      mockSchedule.create.mockRejectedValue(new Error("temporal down"));

      const result = await client.schedule.create("processOrder", {
        scheduleId: "daily-sweep",
        spec: { cronExpressions: ["0 2 * * *"] },
        args: { orderId: "sweep" },
      });

      expect(result).toBeDefect();
      if (result.isDefect()) {
        expect(result.cause).toBeInstanceOf(RuntimeClientError);
      }
    });
  });

  describe("list", () => {
    it("is a typed async-iterable passthrough of ScheduleClient.list", async () => {
      const summaries = [{ scheduleId: "a" }, { scheduleId: "b" }];
      mockSchedule.list.mockReturnValue(
        (async function* () {
          for (const summary of summaries) yield summary;
        })(),
      );

      const seen: string[] = [];
      for await (const summary of client.schedule.list({ pageSize: 10 })) {
        seen.push(summary.scheduleId);
      }

      expect(seen).toEqual(["a", "b"]);
      expect(mockSchedule.list).toHaveBeenCalledWith({ pageSize: 10 });
    });
  });
});
