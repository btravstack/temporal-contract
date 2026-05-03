/**
 * Coverage for the hoisted signal/query/update bind helpers
 * (`bindSignalHandler`, `bindQueryHandler`, `bindUpdateHandler`).
 *
 * Mocks `@temporalio/workflow`'s `defineSignal/Query/Update` and
 * `setHandler` so the helpers are exercisable outside a real workflow
 * context. Asserts that:
 *
 * - missing-block runtime guards fire with a clear error,
 * - unknown-name runtime guards fire with a clear error,
 * - validation failures throw the right typed error class,
 * - the handler receives the *validated* (parsed) input,
 * - query's sync-only validation guard rejects async-validating schemas,
 * - update's output is validated against the contract before resolving.
 *
 * Closes #185.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "@temporal-contract/contract";

const captured: Array<{ kind: string; name: string; impl: (...args: unknown[]) => unknown }> = [];

vi.mock("@temporalio/workflow", () => ({
  defineSignal: vi.fn((name: string) => ({ kind: "signal", name }) as const),
  defineQuery: vi.fn((name: string) => ({ kind: "query", name }) as const),
  defineUpdate: vi.fn((name: string) => ({ kind: "update", name }) as const),
  setHandler: vi.fn(
    (handle: { kind: string; name: string }, impl: (...args: unknown[]) => unknown) => {
      captured.push({ kind: handle.kind, name: handle.name, impl });
    },
  ),
}));

const { bindSignalHandler, bindQueryHandler, bindUpdateHandler } = await import("./handlers.js");
const {
  QueryInputValidationError,
  QueryOutputValidationError,
  SignalInputValidationError,
  UpdateInputValidationError,
  UpdateOutputValidationError,
} = await import("./errors.js");

// Schema library used as a stand-in for an async-only validator. Each
// validate() call returns a Promise rather than the parsed value — used
// to verify the query helper trips the sync-only guard rather than
// silently breaking Temporal's query semantics.
const asyncStringSchema = {
  "~standard": {
    version: 1 as const,
    vendor: "test-async",
    validate: (input: unknown) => Promise.resolve({ value: input, issues: undefined }),
  },
};

const workflow = defineWorkflow({
  input: z.object({ id: z.string() }),
  output: z.object({}),
  signals: {
    cancel: { input: z.tuple([z.object({ reason: z.string() })]) },
  },
  queries: {
    progress: { input: z.tuple([]), output: z.number() },
  },
  updates: {
    bumpAttempt: { input: z.tuple([z.number()]), output: z.object({ attempt: z.number() }) },
  },
});

describe("bindSignalHandler", () => {
  it("validates the payload and forwards the parsed value to the handler", async () => {
    captured.length = 0;
    const handler = vi.fn();
    bindSignalHandler(workflow, "probe", "cancel", handler as never);

    const entry = captured.find((c) => c.kind === "signal" && c.name === "cancel");
    expect(entry).toBeDefined();
    await entry!.impl([{ reason: "user requested" }]);

    // The signal's input schema is `z.tuple([{ reason }])`, so the
    // validated value the handler receives is the parsed tuple.
    expect(handler).toHaveBeenCalledWith([{ reason: "user requested" }]);
  });

  it("throws SignalInputValidationError when the payload doesn't match the contract", async () => {
    captured.length = 0;
    bindSignalHandler(workflow, "probe", "cancel", vi.fn() as never);
    const entry = captured.find((c) => c.kind === "signal" && c.name === "cancel")!;
    // Wrong shape — missing `reason`.
    await expect(entry.impl([{ wrongField: 1 }])).rejects.toBeInstanceOf(
      SignalInputValidationError,
    );
  });

  it("throws a clear error when the workflow has no signals block", () => {
    const noSignals = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
    });
    expect(() => bindSignalHandler(noSignals, "probe", "cancel", vi.fn() as never)).toThrow(
      /workflow "probe" has no signals/,
    );
  });

  it("throws a clear error when the signal name isn't declared", () => {
    expect(() => bindSignalHandler(workflow, "probe", "nope", vi.fn() as never)).toThrow(
      /Signal "nope" not found/,
    );
  });
});

describe("bindQueryHandler", () => {
  it("validates input + output synchronously and returns the parsed result", () => {
    captured.length = 0;
    const handler = vi.fn().mockReturnValue(42);
    bindQueryHandler(workflow, "probe", "progress", handler as never);

    const entry = captured.find((c) => c.kind === "query" && c.name === "progress")!;
    const result = entry.impl([]);
    expect(handler).toHaveBeenCalledWith([]);
    expect(result).toBe(42);
  });

  it("throws QueryInputValidationError on bad input", () => {
    captured.length = 0;
    bindQueryHandler(workflow, "probe", "progress", vi.fn().mockReturnValue(0) as never);
    const entry = captured.find((c) => c.kind === "query" && c.name === "progress")!;
    // Pass a non-tuple input.
    expect(() => entry.impl(["bad"])).toThrow(QueryInputValidationError);
  });

  it("throws QueryOutputValidationError when handler returns a value the contract rejects", () => {
    captured.length = 0;
    // Handler returns wrong type (string instead of number) — output schema rejects.
    bindQueryHandler(
      workflow,
      "probe",
      "progress",
      vi.fn().mockReturnValue("not a number") as never,
    );
    const entry = captured.find((c) => c.kind === "query" && c.name === "progress")!;
    expect(() => entry.impl([])).toThrow(QueryOutputValidationError);
  });

  it("throws a clear error when input validation is async (Temporal queries must be sync)", () => {
    captured.length = 0;
    const wfWithAsyncQuery = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      queries: {
        progress: { input: asyncStringSchema, output: z.number() },
      },
    });
    bindQueryHandler(wfWithAsyncQuery, "probe", "progress", vi.fn().mockReturnValue(1) as never);
    const entry = captured.find((c) => c.kind === "query" && c.name === "progress")!;
    expect(() => entry.impl(["x"])).toThrow(/validation must be synchronous/);
  });

  it("throws a clear error when output validation is async", () => {
    captured.length = 0;
    const wfWithAsyncOutput = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      queries: {
        progress: { input: z.tuple([]), output: asyncStringSchema },
      },
    });
    bindQueryHandler(wfWithAsyncOutput, "probe", "progress", vi.fn().mockReturnValue("x") as never);
    const entry = captured.find((c) => c.kind === "query" && c.name === "progress")!;
    expect(() => entry.impl([])).toThrow(/output validation must be synchronous/);
  });

  it("throws a clear error when the workflow has no queries block", () => {
    const noQueries = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
    });
    expect(() => bindQueryHandler(noQueries, "probe", "progress", vi.fn() as never)).toThrow(
      /workflow "probe" has no queries/,
    );
  });
});

describe("bindUpdateHandler", () => {
  it("validates input + output and forwards the parsed input to the handler", async () => {
    captured.length = 0;
    const handler = vi.fn(async () => ({ attempt: 3 }));
    bindUpdateHandler(workflow, "probe", "bumpAttempt", handler as never);

    const entry = captured.find((c) => c.kind === "update" && c.name === "bumpAttempt")!;
    const result = await entry.impl([7]);
    expect(handler).toHaveBeenCalledWith([7]);
    expect(result).toEqual({ attempt: 3 });
  });

  it("throws UpdateInputValidationError on bad input", async () => {
    captured.length = 0;
    bindUpdateHandler(workflow, "probe", "bumpAttempt", (async () => ({ attempt: 0 })) as never);
    const entry = captured.find((c) => c.kind === "update" && c.name === "bumpAttempt")!;
    await expect(entry.impl(["not a number"])).rejects.toBeInstanceOf(UpdateInputValidationError);
  });

  it("throws UpdateOutputValidationError when the handler returns the wrong shape", async () => {
    captured.length = 0;
    bindUpdateHandler(workflow, "probe", "bumpAttempt", (async () => ({ wrongKey: 1 })) as never);
    const entry = captured.find((c) => c.kind === "update" && c.name === "bumpAttempt")!;
    await expect(entry.impl([1])).rejects.toBeInstanceOf(UpdateOutputValidationError);
  });

  it("throws a clear error when the workflow has no updates block", () => {
    const noUpdates = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
    });
    expect(() => bindUpdateHandler(noUpdates, "probe", "bumpAttempt", vi.fn() as never)).toThrow(
      /workflow "probe" has no updates/,
    );
  });
});
