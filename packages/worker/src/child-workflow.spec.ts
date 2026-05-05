/**
 * Unit coverage for `classifyChildWorkflowError`. Mirrors the client-side
 * `classifyResultError` discrimination pattern so worker-side child-workflow
 * failures surface the *unwrapped* underlying failure as `cause` rather than
 * Temporal's outer `ChildWorkflowFailure` wrapper.
 *
 * Closes audit findings #1 (worker child-workflow cause unwrapping) and
 * #11 (`WorkflowFailedError.cause` typing).
 */
import { describe, expect, it } from "vitest";
import {
  ApplicationFailure,
  CancelledFailure,
  ChildWorkflowFailure,
  TerminatedFailure,
  TimeoutFailure,
  TimeoutType,
} from "@temporalio/common";
import { RetryState } from "@temporalio/common";
import { classifyChildWorkflowError } from "./internal.js";
import {
  ChildWorkflowCancelledError,
  ChildWorkflowError,
  ChildWorkflowNotFoundError,
} from "./errors.js";

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
  });
});
