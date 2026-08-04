import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import {
  ApplicationFailure,
  CancelledFailure,
  ChildWorkflowFailure,
  TerminatedFailure,
  TimeoutFailure,
  TimeoutType,
} from "@temporalio/common";
import { RetryState } from "@temporalio/common";
/**
 * Unit coverage for `classifyChildWorkflowError`. Mirrors the client-side
 * `classifyResultError` discrimination pattern so worker-side child-workflow
 * failures surface the *unwrapped* underlying failure as `cause` rather than
 * Temporal's outer `ChildWorkflowFailure` wrapper.
 *
 * Closes audit findings #1 (worker child-workflow cause unwrapping) and
 * #11 (`WorkflowFailedError.cause` typing).
 *
 * Also covers contract-declared idempotency (`workflowIdReusePolicy`) at
 * both child-start paths — `startChildWorkflow` and `executeChildWorkflow`
 * — the same pattern `client.spec.ts`'s "contract-declared idempotency"
 * block uses for the client's own three start paths. `@temporalio/workflow`
 * is mocked (its `startChild`/`executeChild` faked to capture the options
 * they were called with) rather than run against a real/time-skipping
 * server, because what's under test here is purely the ARGS SHAPE
 * `child-workflow.ts` builds — the same technique the now-deleted
 * `wire-format.spec.ts` used before it was replaced by
 * `child-wire.inprocess.spec.ts`'s real-server EFFECT proofs (see that
 * file's header comment). A real server can't easily assert precedence
 * (contract mode vs. an explicit per-call override) without a second full
 * workflow run per case; a captured-call assertion proves it directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ChildWorkflowCancelledError,
  ChildWorkflowError,
  ChildWorkflowNotFoundError,
} from "./errors.js";
import { classifyChildWorkflowError } from "./internal.js";

type ChildCall = { workflowName: string; options: Record<string, unknown> };

const startChildCalls: ChildCall[] = [];
const executeChildCalls: ChildCall[] = [];
let childResultValue: unknown;

vi.mock("@temporalio/workflow", async () => {
  const actual =
    await vi.importActual<typeof import("@temporalio/workflow")>("@temporalio/workflow");
  return {
    ...actual,
    startChild: async (workflowName: string, options: Record<string, unknown>) => {
      startChildCalls.push({ workflowName, options });
      return {
        workflowId: "child-1",
        firstExecutionRunId: "run-1",
        signal: async () => undefined,
        result: async () => childResultValue,
      };
    },
    executeChild: async (workflowName: string, options: Record<string, unknown>) => {
      executeChildCalls.push({ workflowName, options });
      return childResultValue;
    },
  };
});

const { createExecuteChildWorkflow, createStartChildWorkflow } =
  await import("./child-workflow.js");

// Minimal stand-in for a `WorkflowExecution`. The classify helper never
// inspects the field — it only reads `.cause` off the wrapper — so the
// shape just needs to satisfy the constructor.
const execution = { workflowId: "child-1", runId: "run-1" };

const buildChildFailure = (cause: Error | undefined) =>
  new ChildWorkflowFailure(
    "default",
    execution,
    "childWorkflow",
    RetryState.RETRY_STATE_NON_RETRYABLE_FAILURE,
    cause,
  );

describe("classifyChildWorkflowError", () => {
  describe("ChildWorkflowFailure unwrapping", () => {
    it("forwards an inner ApplicationFailure as the surfaced `cause`", () => {
      const inner = ApplicationFailure.create({
        type: "PaymentDeclined",
        message: "card declined",
      });
      const wrapper = buildChildFailure(inner);

      const result = classifyChildWorkflowError("executeChild", wrapper, "processPayment");

      expect(result).toBeInstanceOf(ChildWorkflowError);
      expect(result).not.toBeInstanceOf(ChildWorkflowCancelledError);
      const surfaced = result as ChildWorkflowError;
      // The unwrap step is what this test exists for: the consumer should
      // not have to peel `ChildWorkflowFailure → ApplicationFailure` themselves.
      expect(surfaced.cause).toBe(inner);
      expect(surfaced.cause).not.toBe(wrapper);
      // Structured field (v8): no message parsing needed for the child name.
      expect(surfaced.workflowName).toBe("processPayment");
      expect(surfaced.message).toContain(`"processPayment"`);
      expect(surfaced.message).toContain("card declined");
    });

    it("forwards an inner TimeoutFailure as the surfaced `cause`", () => {
      const inner = new TimeoutFailure(
        "child timed out",
        undefined,
        TimeoutType.TIMEOUT_TYPE_START_TO_CLOSE,
      );
      const wrapper = buildChildFailure(inner);

      const result = classifyChildWorkflowError("executeChild", wrapper, "slowWorkflow");

      expect(result).toBeInstanceOf(ChildWorkflowError);
      expect((result as ChildWorkflowError).cause).toBe(inner);
    });

    it("forwards an inner TerminatedFailure as the surfaced `cause`", () => {
      const inner = new TerminatedFailure("child terminated by user");
      const wrapper = buildChildFailure(inner);

      const result = classifyChildWorkflowError("result", wrapper, "longRunning");

      expect(result).toBeInstanceOf(ChildWorkflowError);
      expect((result as ChildWorkflowError).cause).toBe(inner);
    });

    it("falls back to the wrapper itself when the wrapper has no cause", () => {
      // ChildWorkflowFailure should always carry a cause in practice, but
      // the type system says `cause?: Error`. Falling through to the wrapper
      // preserves error identity rather than producing a `cause === undefined`.
      const wrapper = buildChildFailure(undefined);

      const result = classifyChildWorkflowError("startChild", wrapper, "noCauseChild");

      expect(result).toBeInstanceOf(ChildWorkflowError);
      expect((result as ChildWorkflowError).cause).toBe(wrapper);
    });
  });

  describe("cancellation discrimination", () => {
    it("surfaces a bare CancelledFailure as ChildWorkflowCancelledError", () => {
      const error = new CancelledFailure("scope cancelled");

      const result = classifyChildWorkflowError("executeChild", error, "cancelMe");

      expect(result).toBeInstanceOf(ChildWorkflowCancelledError);
      const surfaced = result as ChildWorkflowCancelledError;
      expect(surfaced.workflowName).toBe("cancelMe");
      expect(surfaced.cause).toBe(error);
    });

    it("surfaces a ChildWorkflowFailure caused by CancelledFailure as ChildWorkflowCancelledError", () => {
      // Real Temporal cancellation surfaces this way: the outer failure is
      // ChildWorkflowFailure, the inner cause is CancelledFailure.
      // `isCancellation` sees through the wrapper, so cancellation wins
      // over the generic `instanceof ChildWorkflowFailure` branch.
      const inner = new CancelledFailure("child cancelled");
      const wrapper = buildChildFailure(inner);

      const result = classifyChildWorkflowError("executeChild", wrapper, "cancelMe");

      expect(result).toBeInstanceOf(ChildWorkflowCancelledError);
      const surfaced = result as ChildWorkflowCancelledError;
      // The cancelled-error carries the original error so callers can
      // still walk the chain if they need to, but the discriminant is
      // what matters.
      expect(surfaced.cause).toBe(wrapper);
    });

    it("surfaces cancellation from `result` operation correctly", () => {
      const error = new CancelledFailure("workflow cancelled");

      const result = classifyChildWorkflowError("result", error, "child-2");

      expect(result).toBeInstanceOf(ChildWorkflowCancelledError);
      expect((result as ChildWorkflowCancelledError).workflowName).toBe("child-2");
    });
  });

  describe("non-Temporal errors", () => {
    it("wraps an arbitrary Error as ChildWorkflowError with the raw cause", () => {
      const raw = new Error("network hiccup");

      const result = classifyChildWorkflowError("startChild", raw, "anyChild");

      expect(result).toBeInstanceOf(ChildWorkflowError);
      expect(result).not.toBeInstanceOf(ChildWorkflowCancelledError);
      expect(result).not.toBeInstanceOf(ChildWorkflowNotFoundError);
      expect((result as ChildWorkflowError).cause).toBe(raw);
      expect((result as ChildWorkflowError).workflowName).toBe("anyChild");
      expect((result as ChildWorkflowError).message).toContain("network hiccup");
    });

    it("handles non-Error thrown values without crashing", () => {
      const result = classifyChildWorkflowError("startChild", "string error", "anyChild");

      expect(result).toBeInstanceOf(ChildWorkflowError);
      expect((result as ChildWorkflowError).cause).toBe("string error");
      expect((result as ChildWorkflowError).message).toContain("string error");
    });
  });

  describe("operation-specific messages", () => {
    it("uses the start-child phrasing for `startChild`", () => {
      const result = classifyChildWorkflowError("startChild", new Error("boom"), "myChild");
      expect(result.message).toContain("Failed to start child workflow");
      expect(result.message).toContain("myChild");
    });

    it("uses the execute-child phrasing for `executeChild`", () => {
      const result = classifyChildWorkflowError("executeChild", new Error("boom"), "myChild");
      expect(result.message).toContain("Failed to execute child workflow");
    });

    it("uses the result phrasing for `result`", () => {
      const result = classifyChildWorkflowError("result", new Error("boom"), "myChild");
      expect(result.message).toContain("execution failed");
    });

    it("uses the signal phrasing for `signal`", () => {
      const result = classifyChildWorkflowError("signal", new Error("boom"), "myChild");
      expect(result.message).toContain("Failed to signal child workflow");
      expect(result.message).toContain("myChild");
    });
  });
});

describe("contract-declared idempotency", () => {
  // `onceChild` declares "once-per-id" so its default policy
  // (REJECT_DUPLICATE) is distinguishable from Temporal's own default
  // (ALLOW_DUPLICATE) — see `client.spec.ts`'s identical rationale.
  const onceChild = defineWorkflow({
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
    idempotency: "once-per-id",
  });

  // Simulates a definition that reaches the worker without `idempotency` at
  // runtime despite the field now being required at the type level (e.g. a
  // contract assembled dynamically outside the type system, or an older
  // compiled artifact) — the `as unknown as typeof onceChild` cast is the
  // point, not a mistake. The defensive `definition.idempotency ? {
  // workflowIdReusePolicy: … } : {}` guard in `child-workflow.ts` must stay
  // inert for exactly this case.
  const plainChild = {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  } as unknown as typeof onceChild;

  const idempotencyContract = defineContract({
    taskQueue: "child-idempotency-queue",
    workflows: {
      onceChild,
      plainChild,
    },
  });

  beforeEach(() => {
    startChildCalls.length = 0;
    executeChildCalls.length = 0;
    childResultValue = { ok: true };
  });

  describe("startChildWorkflow", () => {
    it("applies the contract's mode as workflowIdReusePolicy", async () => {
      const result = await createStartChildWorkflow(idempotencyContract, "onceChild", {
        workflowId: "child-once-1",
        args: { id: "a" },
      });

      expect(result).toBeOk();
      expect(startChildCalls).toEqual([
        {
          workflowName: "onceChild",
          options: {
            workflowId: "child-once-1",
            workflowIdReusePolicy: "REJECT_DUPLICATE",
            taskQueue: "child-idempotency-queue",
            args: [{ id: "a" }],
          },
        },
      ]);
    });

    // This is the test that catches a contract-after-spread mistake: the
    // "applies" test above only proves the field is set to SOMETHING, not
    // that a caller can still win. Precedence is expressed independently at
    // each call site's own spread, so a mistake at this site is invisible
    // to `executeChildWorkflow`'s equivalent test below.
    it("lets an explicit per-call workflowIdReusePolicy override the contract", async () => {
      const result = await createStartChildWorkflow(idempotencyContract, "onceChild", {
        workflowId: "child-once-2",
        args: { id: "a" },
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
      });

      expect(result).toBeOk();
      expect(startChildCalls).toEqual([
        {
          workflowName: "onceChild",
          options: {
            workflowId: "child-once-2",
            workflowIdReusePolicy: "ALLOW_DUPLICATE",
            taskQueue: "child-idempotency-queue",
            args: [{ id: "a" }],
          },
        },
      ]);
    });

    it("sends no policy when the contract declares none", async () => {
      const result = await createStartChildWorkflow(idempotencyContract, "plainChild", {
        workflowId: "child-plain-1",
        args: { id: "a" },
      });

      expect(result).toBeOk();
      // Not even a present-`undefined` key — `toHaveBeenCalledWith`-style
      // equality would not catch that distinction, since vitest treats an
      // `undefined`-valued key as absent under deep equality.
      expect(startChildCalls[0]?.options).not.toHaveProperty("workflowIdReusePolicy");
    });
  });

  describe("executeChildWorkflow", () => {
    it("applies the contract's mode as workflowIdReusePolicy", async () => {
      const result = await createExecuteChildWorkflow(idempotencyContract, "onceChild", {
        workflowId: "child-once-3",
        args: { id: "a" },
      });

      expect(result).toBeOk();
      expect(executeChildCalls).toEqual([
        {
          workflowName: "onceChild",
          options: {
            workflowId: "child-once-3",
            workflowIdReusePolicy: "REJECT_DUPLICATE",
            taskQueue: "child-idempotency-queue",
            args: [{ id: "a" }],
          },
        },
      ]);
    });

    it("lets an explicit per-call workflowIdReusePolicy override the contract", async () => {
      const result = await createExecuteChildWorkflow(idempotencyContract, "onceChild", {
        workflowId: "child-once-4",
        args: { id: "a" },
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
      });

      expect(result).toBeOk();
      expect(executeChildCalls).toEqual([
        {
          workflowName: "onceChild",
          options: {
            workflowId: "child-once-4",
            workflowIdReusePolicy: "ALLOW_DUPLICATE",
            taskQueue: "child-idempotency-queue",
            args: [{ id: "a" }],
          },
        },
      ]);
    });

    it("sends no policy when the contract declares none", async () => {
      const result = await createExecuteChildWorkflow(idempotencyContract, "plainChild", {
        workflowId: "child-plain-2",
        args: { id: "a" },
      });

      expect(result).toBeOk();
      expect(executeChildCalls[0]?.options).not.toHaveProperty("workflowIdReusePolicy");
    });
  });
});
