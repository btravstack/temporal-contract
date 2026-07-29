import { defineContract, defineWorkflow } from "@temporal-contract/contract";
/**
 * Wire-format coverage (D1: validate on send, parse on receive) for the
 * workflow entry point and the child-workflow helpers.
 *
 * Every payload boundary parses exactly once, on the receiving side. The
 * sending side still validates — failing early with the existing typed
 * error — but transmits the caller's ORIGINAL value. Transforming schemas
 * (`z.string().transform(...)`) make the two sides observable:
 *
 * - `declareWorkflow` input: the worker is the receiving side, so the
 *   implementation sees the parsed value.
 * - `declareWorkflow` output: the worker is the sending side, so Temporal
 *   gets the implementation's original return; the client parses it.
 * - child-workflow args: the parent is the sending side (original goes over
 *   the wire); the child's `declareWorkflow` parses on receive.
 * - child-workflow result: the parent is the receiving side (parses once).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

type ChildCall = { workflowName: string; options: Record<string, unknown> };
type SignalCall = { signalName: string; args: unknown[] };

const executeChildCalls: ChildCall[] = [];
const startChildCalls: ChildCall[] = [];
const childSignalCalls: SignalCall[] = [];
let childResultValue: unknown;

vi.mock("@temporalio/workflow", async () => {
  const actual =
    await vi.importActual<typeof import("@temporalio/workflow")>("@temporalio/workflow");
  return {
    ...actual,
    workflowInfo: () => ({ workflowId: "test-wf", runId: "test-run" }),
    executeChild: async (workflowName: string, options: Record<string, unknown>) => {
      executeChildCalls.push({ workflowName, options });
      return childResultValue;
    },
    startChild: async (workflowName: string, options: Record<string, unknown>) => {
      startChildCalls.push({ workflowName, options });
      return {
        workflowId: "child-1",
        firstExecutionRunId: "run-1",
        signal: async (signalName: string, ...args: unknown[]) => {
          childSignalCalls.push({ signalName, args });
        },
        result: async () => childResultValue,
      };
    },
  };
});

const { declareWorkflow } = await import("./workflow.js");
const { createExecuteChildWorkflow, createStartChildWorkflow } =
  await import("./child-workflow.js");

const contract = defineContract({
  taskQueue: "wire-q",
  workflows: {
    transformer: defineWorkflow({
      input: z.object({ text: z.string().transform((s) => `${s}!`) }),
      output: z.object({ n: z.number().transform((n) => n * 2) }),
    }),
    signalful: defineWorkflow({
      input: z.object({}),
      output: z.object({ n: z.number() }),
      signals: {
        note: { input: z.object({ text: z.string().transform((s) => `${s}!`) }) },
      },
    }),
  },
});

afterEach(() => {
  executeChildCalls.length = 0;
  startChildCalls.length = 0;
  childSignalCalls.length = 0;
  childResultValue = undefined;
});

describe("declareWorkflow — wire format", () => {
  it("the implementation receives the PARSED input (transform applied once)", async () => {
    const seen: unknown[] = [];
    const handler = declareWorkflow({
      workflowName: "transformer",
      contract,
      implementation: async (_context, args) => {
        seen.push(args);
        return { n: 21 };
      },
    });

    await handler({ text: "hi" });

    // The client transmitted the original `{ text: "hi" }`; the boundary
    // parse happens exactly once, here on the receiving side.
    expect(seen).toEqual([{ text: "hi!" }]);
  });

  it("Temporal gets the implementation's ORIGINAL output, not the parsed value", async () => {
    const handler = declareWorkflow({
      workflowName: "transformer",
      contract,
      implementation: async () => ({ n: 21 }),
    });

    const result = await handler({ text: "hi" });

    // Validated against the output schema, but transmitted untransformed —
    // the client parses the result on receive (21 → 42 exactly once).
    expect(result).toEqual({ n: 21 });
  });

  it("still fails the execution on invalid output", async () => {
    const handler = declareWorkflow({
      workflowName: "transformer",
      contract,
      implementation: async () => ({ n: "not a number" }) as never,
    });

    await expect(handler({ text: "hi" })).rejects.toThrow(/output validation failed/);
  });
});

describe("child workflows — wire format", () => {
  it("executeChildWorkflow sends the ORIGINAL args and parses the result once", async () => {
    childResultValue = { n: 21 };

    const result = await createExecuteChildWorkflow(contract, "transformer", {
      workflowId: "child-1",
      args: { text: "hi" },
    });

    // Parent is the sending side of the input boundary — the child's
    // `declareWorkflow` parses on receive.
    expect(executeChildCalls).toEqual([
      {
        workflowName: "transformer",
        options: expect.objectContaining({ args: [{ text: "hi" }] }),
      },
    ]);
    // Parent is the receiving side of the result boundary — parses once.
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ n: 42 });
    }
  });

  it("startChildWorkflow sends the ORIGINAL args; handle.result() parses once", async () => {
    childResultValue = { n: 21 };

    const handleResult = await createStartChildWorkflow(contract, "transformer", {
      workflowId: "child-1",
      args: { text: "hi" },
    });

    expect(startChildCalls).toEqual([
      {
        workflowName: "transformer",
        options: expect.objectContaining({ args: [{ text: "hi" }] }),
      },
    ]);
    expect(handleResult.isOk()).toBe(true);
    if (handleResult.isOk()) {
      const result = await handleResult.value.result();
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({ n: 42 });
      }
    }
  });
});

describe("typed child workflow handle — signals and identifiers", () => {
  it("exposes firstExecutionRunId from the underlying handle", async () => {
    const handleResult = await createStartChildWorkflow(contract, "signalful", {
      workflowId: "child-1",
      args: {},
    });

    expect(handleResult.isOk()).toBe(true);
    if (handleResult.isOk()) {
      expect(handleResult.value.workflowId).toBe("child-1");
      expect(handleResult.value.firstExecutionRunId).toBe("run-1");
    }
  });

  it("signals validate the args but transmit the ORIGINAL value (D1)", async () => {
    const handleResult = await createStartChildWorkflow(contract, "signalful", {
      workflowId: "child-1",
      args: {},
    });
    expect(handleResult.isOk()).toBe(true);
    if (!handleResult.isOk()) return;

    const sent = await handleResult.value.signals.note({ text: "hi" });

    expect(sent.isOk()).toBe(true);
    // Validated (transform would yield "hi!") but the ORIGINAL value crosses
    // the wire — the child's signal handler parses on receive.
    expect(childSignalCalls).toEqual([{ signalName: "note", args: [{ text: "hi" }] }]);
  });

  it("signals surface a validation failure as Err(ChildWorkflowError) without sending", async () => {
    const handleResult = await createStartChildWorkflow(contract, "signalful", {
      workflowId: "child-1",
      args: {},
    });
    expect(handleResult.isOk()).toBe(true);
    if (!handleResult.isOk()) return;

    const sent = await handleResult.value.signals.note({ text: 42 } as never);

    expect(sent.isErr()).toBe(true);
    if (sent.isErr()) {
      expect(sent.error.message).toContain('signal "note" input validation failed');
    }
    expect(childSignalCalls).toEqual([]);
  });
});
