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
import { WorkflowInputValidationError } from "./errors.js";

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

    await expect(continueAsNew({ n: "not a number" })).rejects.toBeInstanceOf(
      WorkflowInputValidationError,
    );
    await expect(continueAsNew({ n: "not a number" })).rejects.toMatchObject({
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
    ).rejects.toBeInstanceOf(WorkflowInputValidationError);
    await expect(
      continueAsNew(otherContract, "archive", { id: "wrong-key" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(`Workflow "archive" input validation failed`),
    });
    expect(captured).toHaveLength(0);
  });

  it("cross-contract: rejects with WorkflowInputValidationError when the target workflow isn't declared", async () => {
    const continueAsNew = createContinueAsNew(contract, "counter");

    await expect(continueAsNew(otherContract, "ghost", { batchId: "B-1" })).rejects.toBeInstanceOf(
      WorkflowInputValidationError,
    );
    await expect(continueAsNew(otherContract, "ghost", { batchId: "B-1" })).rejects.toMatchObject({
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

  describe("cross-contract dispatch heuristic", () => {
    // Same-workflow inputs that happen to share keys with a contract
    // shouldn't be misrouted into the cross-contract branch. The dispatch
    // requires both: (1) `arg1` looks contract-shaped (taskQueue: string,
    // workflows: non-null object), AND (2) `arg2` is a string. None of the
    // same-workflow signatures accept a string as `arg2`, so requiring it
    // shrinks the false-positive surface to almost nothing.

    it("treats a same-workflow input with taskQueue+workflows keys as same-workflow (no string arg2)", async () => {
      // Input shape that *looks* contract-y but is actually the workflow's
      // own payload. With only the loose two-key check, this would have
      // been misclassified.
      const treacherousInput = {
        taskQueue: "hostile",
        workflows: { counter: { input: { "~standard": { validate: () => null } } } },
      };
      const looseCounterContract = defineContract({
        taskQueue: "tq",
        workflows: {
          counter: defineWorkflow({
            input: z.object({
              taskQueue: z.string(),
              workflows: z.object({
                counter: z.object({
                  input: z.object({
                    "~standard": z.object({ validate: z.unknown() }),
                  }),
                }),
              }),
            }),
            output: z.object({}),
          }),
        },
      });

      const continueAsNew = createContinueAsNew(looseCounterContract, "counter");

      // Called with a single arg → arg2 is undefined → not a string → must
      // be classified as same-workflow even though arg1 looks contract-y.
      await expect(continueAsNew(treacherousInput)).rejects.toThrow("__STUB_CONTINUE_AS_NEW__");

      expect(captured[0]?.options.workflowType).toBe("counter");
      expect(captured[0]?.options.taskQueue).toBe("tq");
    });

    it("does not misroute when workflows is null (typeof null === 'object')", async () => {
      const treacherous = { taskQueue: "x", workflows: null };
      const c = defineContract({
        taskQueue: "tq",
        workflows: {
          handler: defineWorkflow({
            // Allow the treacherous shape through this workflow's input
            // schema so we exercise *the dispatch*, not validation.
            input: z.object({
              taskQueue: z.string(),
              workflows: z.null(),
            }),
            output: z.object({}),
          }),
        },
      });
      const continueAsNew = createContinueAsNew(c, "handler");

      await expect(continueAsNew(treacherous, "ignored-name")).rejects.toThrow(
        "__STUB_CONTINUE_AS_NEW__",
      );

      // arg2 is a string, but arg1.workflows is null → check fails → routes
      // as same-workflow. workflowType reflects the current workflow.
      expect(captured[0]?.options.workflowType).toBe("handler");
    });
  });
});
