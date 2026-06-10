/**
 * Runtime coverage for `declareWorkflow`'s `.name` surfacing.
 *
 * Temporal's client-side `client.workflow.start(fn, ...)` derives the
 * workflow type from `fn.name`. The arrow returned by `declareWorkflow`
 * would otherwise be anonymous (`fn.name === ""`), so users passing the
 * declaration by reference (typically in tests, where the typed client's
 * string lookup is sidestepped) would hit an empty workflow type.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import { declareWorkflow } from "./workflow.js";

const contract = defineContract({
  taskQueue: "tq",
  workflows: {
    processOrder: defineWorkflow({
      input: z.object({}),
      output: z.object({}),
    }),
    cancelOrder: defineWorkflow({
      input: z.object({}),
      output: z.object({}),
    }),
  },
});

describe("declareWorkflow", () => {
  it("exposes the contract workflow name via fn.name", () => {
    const fn = declareWorkflow({
      workflowName: "processOrder",
      contract,
      implementation: async (_context, _input) => ({}),
      activityOptions: { startToCloseTimeout: "1 minute" },
    });

    expect(fn.name).toBe("processOrder");
  });

  it("uses the contract name even when bound to a differently-named const", () => {
    // Guards against accidental reliance on variable-name inference —
    // confirms the explicit Object.defineProperty is doing the work.
    const handler = declareWorkflow({
      workflowName: "cancelOrder",
      contract,
      implementation: async (_context, _input) => ({}),
      activityOptions: { startToCloseTimeout: "1 minute" },
    });

    expect(handler.name).toBe("cancelOrder");
  });

  it("keeps fn.name configurable for tooling overrides", () => {
    // Locks in the descriptor shape so a future refactor flipping to
    // configurable: false (and breaking instrumentation) is caught.
    const fn = declareWorkflow({
      workflowName: "processOrder",
      contract,
      implementation: async (_context, _input) => ({}),
      activityOptions: { startToCloseTimeout: "1 minute" },
    });

    expect(Object.getOwnPropertyDescriptor(fn, "name")?.configurable).toBe(true);
  });
});
