/**
 * Coverage for the typed `context.continueAsNew(...)` helper.
 *
 * Mocks `@temporalio/workflow.makeContinueAsNewFunc` so the helper is callable
 * outside a real workflow context. Asserts that:
 * - args are validated against the destination workflow's input schema before
 *   Temporal's continueAsNew is invoked,
 * - validation failures throw `WorkflowInputValidationError`,
 * - same-workflow and cross-contract dispatch routes the right
 *   workflowType/taskQueue/args to Temporal,
 * - user-provided options are forwarded onto `makeContinueAsNewFunc`.
 *
 * Closes #179.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ContinueAsNewOptions } from "@temporalio/workflow";
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";

type CapturedCall = { options: ContinueAsNewOptions; args: unknown[] };

const captured: CapturedCall[] = [];

vi.mock("@temporalio/workflow", async () => {
  const actual =
    await vi.importActual<typeof import("@temporalio/workflow")>("@temporalio/workflow");
  return {
    ...actual,
    makeContinueAsNewFunc: (options: ContinueAsNewOptions) => {
      // Return a stub that records the args it was called with under the
      // captured options bag, then "throws" by rejecting — matching
      // Temporal's "never returns" semantics in a way the test can observe.
      return (...args: unknown[]) => {
        captured.push({ options, args });
        return Promise.reject(new Error("__STUB_CONTINUE_AS_NEW__"));
      };
    },
  };
});

const { createContinueAsNew } = await import("./internal.js");

const contract = defineContract({
  taskQueue: "tq-current",
  workflows: {
    counter: defineWorkflow({
      input: z.object({ n: z.number() }),
      output: z.object({}),
    }),
    other: defineWorkflow({
      input: z.object({ id: z.string() }),
      output: z.object({}),
    }),
  },
  activities: {
    log: defineActivity({
      input: z.object({ message: z.string() }),
      output: z.object({}),
    }),
  },
});

const otherContract = defineContract({
  taskQueue: "tq-other",
  workflows: {
    archive: defineWorkflow({
      input: z.object({ batchId: z.string() }),
      output: z.object({}),
    }),
  },
});

describe("context.continueAsNew", () => {
  afterEach(() => {
    captured.length = 0;
  });

  it("same-workflow: validates args, calls Temporal with current workflow's type and task queue", async () => {
    const continueAsNew = createContinueAsNew(contract, "counter");

    await expect(continueAsNew({ n: 7 })).rejects.toThrow("__STUB_CONTINUE_AS_NEW__");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.options).toMatchObject({
      workflowType: "counter",
      taskQueue: "tq-current",
    });
    expect(captured[0]?.args).toEqual([{ n: 7 }]);
  });

  it("same-workflow: throws WorkflowInputValidationError when args fail validation", async () => {
    const continueAsNew = createContinueAsNew(contract, "counter");

    await expect(continueAsNew({ n: "not a number" })).rejects.toMatchObject({
      name: "WorkflowInputValidationError",
      message: expect.stringContaining(`Workflow "counter" input validation failed`),
    });
    expect(captured).toHaveLength(0);
  });

  it("cross-contract: pulls workflowType and taskQueue from the destination contract", async () => {
    const continueAsNew = createContinueAsNew(contract, "counter");

    await expect(continueAsNew(otherContract, "archive", { batchId: "B-1" })).rejects.toThrow(
      "__STUB_CONTINUE_AS_NEW__",
    );

    expect(captured[0]?.options).toMatchObject({
      workflowType: "archive",
      taskQueue: "tq-other",
    });
    expect(captured[0]?.args).toEqual([{ batchId: "B-1" }]);
  });

  it("cross-contract: validates args against the destination's input schema", async () => {
    const continueAsNew = createContinueAsNew(contract, "counter");

    await expect(
      continueAsNew(otherContract, "archive", { id: "wrong-key" }),
    ).rejects.toMatchObject({
      name: "WorkflowInputValidationError",
      message: expect.stringContaining(`Workflow "archive" input validation failed`),
    });
    expect(captured).toHaveLength(0);
  });

  it("cross-contract: rejects with WorkflowInputValidationError when the target workflow isn't declared", async () => {
    const continueAsNew = createContinueAsNew(contract, "counter");

    await expect(continueAsNew(otherContract, "ghost", { batchId: "B-1" })).rejects.toMatchObject({
      name: "WorkflowInputValidationError",
      message: expect.stringContaining(`continueAsNew target workflow "ghost"`),
    });
    expect(captured).toHaveLength(0);
  });

  it("forwards user-supplied options (e.g. workflowRunTimeout) onto Temporal's continueAsNew", async () => {
    const continueAsNew = createContinueAsNew(contract, "counter");

    await expect(
      continueAsNew({ n: 1 }, { workflowRunTimeout: "1 hour", memo: { tag: "x" } }),
    ).rejects.toThrow();

    expect(captured[0]?.options).toMatchObject({
      workflowType: "counter",
      taskQueue: "tq-current",
      workflowRunTimeout: "1 hour",
      memo: { tag: "x" },
    });
  });

  it("user options can override workflowType at runtime (boundary noted)", async () => {
    // `WorkflowContext.continueAsNew` Omits `workflowType` and `taskQueue` from
    // its options type, so typed call sites can't get here. The runtime is
    // permissive — user options spread last — which lets power users override
    // if they bypass the type. This test documents that boundary.
    const continueAsNew = createContinueAsNew(contract, "counter");

    await expect(
      continueAsNew({ n: 1 }, {
        workflowType: "evil",
      } as unknown as Parameters<typeof continueAsNew>[1]),
    ).rejects.toThrow();

    expect(captured[0]?.options.workflowType).toBe("evil");
  });
});
