import { ContractError } from "@temporal-contract/contract/errors";
import { ApplicationFailure, ActivityFailure, RetryState } from "@temporalio/common";
import { ErrAsync, OkAsync } from "unthrown";
import { describe, expect, it } from "vitest";

import { bestEffort, propagateActivityFailure, propagateFailure } from "./activity-failure.js";
import {
  ActivityCancelledError,
  ActivityError,
  ChildWorkflowCancelledError,
  ChildWorkflowError,
  ChildWorkflowNotFoundError,
  ContractMisuseError,
  WorkflowCancelledError,
} from "./errors.js";

describe("propagateFailure", () => {
  it("returns the value on Ok", async () => {
    await expect(propagateFailure(OkAsync({ ok: true }))).resolves.toEqual({ ok: true });
  });

  it("rethrows the ORIGINAL ActivityFailure wrapper, not the unwrapped cause", async () => {
    // This is the whole point (see activity-failure.ts's doc comment). Real
    // ActivityFailure/ApplicationFailure instances, mirroring exactly what
    // classifyActivityError constructs: `cause` is the unwrapped
    // ApplicationFailure, `originalFailure` is the wrapper Temporal actually
    // threw. Rethrowing `cause` instead would hand Temporal a bare
    // ApplicationFailure where it previously saw an ActivityFailure —
    // changing the client-visible WorkflowFailedError.cause type.
    const innerCause = ApplicationFailure.create({ message: "boom", type: "Boom" });
    const wrapper = new ActivityFailure(
      "activity failed",
      "charge",
      "1",
      RetryState.MAXIMUM_ATTEMPTS_REACHED,
      undefined,
      innerCause,
    );
    const activityError = new ActivityError(
      "charge",
      'Activity "charge" failed: boom',
      innerCause,
      wrapper,
    );

    await expect(propagateFailure(ErrAsync(activityError))).rejects.toBe(wrapper);
  });

  it("falls back to cause when no originalFailure was preserved", async () => {
    const cause = ApplicationFailure.create({ message: "boom", type: "Boom" });
    const activityError = new ActivityError("charge", 'Activity "charge" failed: boom', cause);

    await expect(propagateFailure(ErrAsync(activityError))).rejects.toBe(cause);
  });

  it("rethrows the wrapper itself when neither cause nor originalFailure was preserved", async () => {
    // Never lose the error identity: if there is nothing underneath, the
    // ActivityError itself is the most informative thing available.
    const activityError = new ActivityError("charge", 'Activity "charge" failed: opaque');

    await expect(propagateFailure(ErrAsync(activityError))).rejects.toBe(activityError);
  });

  it("rethrows the preserved cause for a cancelled activity", async () => {
    // ActivityCancelledError has no separate originalFailure: cancellation is
    // detected before classifyActivityError's unwrap, so cause already holds
    // the pre-unwrap original failure — see the class's doc comment.
    const cancelledFailure = ApplicationFailure.create({ message: "cancelled", type: "Cancelled" });
    const cancelled = new ActivityCancelledError("charge", cancelledFailure);

    await expect(propagateFailure(ErrAsync(cancelled))).rejects.toBe(cancelledFailure);
  });

  it("rethrows a cancelled activity's wrapper when no cause was preserved", async () => {
    const cancelled = new ActivityCancelledError("charge");

    await expect(propagateFailure(ErrAsync(cancelled))).rejects.toBe(cancelled);
  });

  it("rethrows a non-ActivityError error value unchanged", async () => {
    const other = new Error("something else");
    await expect(propagateFailure(ErrAsync(other))).rejects.toBe(other);
  });

  it("rethrows the ApplicationFailure cause for a declared ContractError, not the TaggedError wrapper", async () => {
    // A declared contract error is ALSO a TaggedError, not a TemporalFailure.
    // Rethrown bare it wouldn't stall (declareWorkflow's own catch converts
    // any ContractError it sees), but it WOULD misclassify: that catch looks
    // the error name up on the workflow's declared errors, not the
    // activity's, so the common case (name declared only on the activity)
    // produces a misleading "not declared on workflow" failure instead of
    // the activity's real error (Fix round 2, Important — see
    // activity-failure.ts's doc comment). `cause` is the original
    // ApplicationFailure, which is what must escape instead.
    const wireFailure = ApplicationFailure.create({
      type: "PaymentDeclined",
      message: "Card declined",
      nonRetryable: true,
      details: [{ reason: "insufficient_funds" }],
    });
    const contractError = new ContractError({
      errorName: "PaymentDeclined",
      data: { reason: "insufficient_funds" },
      message: "Card declined",
      cause: wireFailure,
    });

    expect(contractError).not.toBeInstanceOf(ApplicationFailure);
    await expect(propagateFailure(ErrAsync(contractError))).rejects.toBe(wireFailure);
  });

  it("rethrows a ContractError itself when no cause was set", async () => {
    const contractError = new ContractError({
      errorName: "PaymentDeclined",
      data: undefined,
      message: "Card declined",
    });

    await expect(propagateFailure(ErrAsync(contractError))).rejects.toBe(contractError);
  });

  it("rethrows the preserved cause for a failed child workflow", async () => {
    // Mirrors ActivityError: `cause` is the unwrapped actionable failure.
    const cause = ApplicationFailure.create({ message: "child failed", type: "Boom" });
    const childError = new ChildWorkflowError("processPayment", "Child workflow failed", cause);

    await expect(propagateFailure(ErrAsync(childError))).rejects.toBe(cause);
  });

  it("converts a causeless child workflow error to a terminal ContractMisuseError, not a bare TaggedError rethrow", async () => {
    // The three child-workflow.ts sites that construct ChildWorkflowError
    // without a cause (input/output/signal-input validation) fire BEFORE any
    // Temporal call — there is no pre-existing TemporalFailure to re-raise.
    // Rethrowing the bare TaggedError would stall the workflow exactly like
    // ChildWorkflowNotFoundError would; it must convert to a terminal
    // ApplicationFailure instead (see activity-failure.ts's doc comment).
    const childError = new ChildWorkflowError("processPayment", "Child workflow failed");

    await expect(propagateFailure(ErrAsync(childError))).rejects.toThrow(ContractMisuseError);
    await expect(propagateFailure(ErrAsync(childError))).rejects.toMatchObject({
      message: childError.message,
      nonRetryable: true,
    });
  });

  it("rethrows the preserved cause for a cancelled child workflow", async () => {
    const cancelledFailure = ApplicationFailure.create({ message: "cancelled", type: "Cancelled" });
    const cancelled = new ChildWorkflowCancelledError("processPayment", cancelledFailure);

    await expect(propagateFailure(ErrAsync(cancelled))).rejects.toBe(cancelledFailure);
  });

  it("rethrows the preserved cause for a cancelled cancellation scope", async () => {
    // WorkflowCancelledError from context.cancellableScope/nonCancellableScope
    // — mirrors ActivityCancelledError's cause handling.
    const cancelledFailure = ApplicationFailure.create({ message: "cancelled", type: "Cancelled" });
    const cancelled = new WorkflowCancelledError(cancelledFailure);

    await expect(propagateFailure(ErrAsync(cancelled))).rejects.toBe(cancelledFailure);
  });

  it("rethrows a cancelled scope's wrapper when no cause was preserved", async () => {
    const cancelled = new WorkflowCancelledError();

    await expect(propagateFailure(ErrAsync(cancelled))).rejects.toBe(cancelled);
  });

  it("converts a not-found child workflow to a terminal ContractMisuseError, not a bare TaggedError rethrow", async () => {
    // ChildWorkflowNotFoundError fires before any Temporal call (the child
    // workflow name isn't declared on the target contract) — there is no
    // pre-existing TemporalFailure to re-raise. Rethrowing it bare would
    // stall the workflow (TaggedError, not TemporalFailure); it must be
    // converted to a terminal ApplicationFailure instead.
    const notFound = new ChildWorkflowNotFoundError("processPayment", ["processOrder"]);

    await expect(propagateFailure(ErrAsync(notFound))).rejects.toThrow(ContractMisuseError);
    await expect(propagateFailure(ErrAsync(notFound))).rejects.toMatchObject({
      message: notFound.message,
      nonRetryable: true,
    });
  });

  // Item 8: the defect channel has no dedicated coverage above — every case
  // drives ErrAsync/OkAsync. Prove this test discriminates by temporarily
  // deleting the `: settled.cause` fallback in activity-failure.ts (hardcode
  // `settled.error`) and observing ONLY this test fail; the eight Err-based
  // tests above stay green because none of them exercise the Defect branch.
  it("classifies a defect's cause through the same chain as an Err — not settled.error", async () => {
    const cause = ApplicationFailure.create({ message: "boom", type: "Boom" });
    const activityError = new ActivityError("charge", 'Activity "charge" failed: boom', cause);

    // A genuine defect: something inside the AsyncResult pipeline THREW
    // `activityError` rather than returning `Err(activityError)`. A defect
    // has no public constructor — a throw inside a combinator is the only
    // way to mint one (see unthrown's `defectOf` test helper).
    const defect = OkAsync(0).map<never>(() => {
      throw activityError;
    });

    await expect(propagateFailure(defect)).rejects.toBe(cause);
  });
});

describe("propagateActivityFailure (deprecated alias)", () => {
  it("is the same function as propagateFailure", () => {
    // Not a behavioural copy — the identical reference, so the alias cannot
    // drift from the helper it stands in for.
    expect(propagateActivityFailure).toBe(propagateFailure);
  });
});

describe("bestEffort", () => {
  it("returns the value and never calls onFailure on Ok", async () => {
    const seen: unknown[] = [];

    await expect(bestEffort(OkAsync({ sent: true }), (f) => seen.push(f))).resolves.toEqual({
      sent: true,
    });
    expect(seen).toEqual([]);
  });

  it("hands a modeled activity failure to onFailure and resolves undefined", async () => {
    const cause = ApplicationFailure.create({ message: "smtp down", type: "NOTIFY_FAILED" });
    const failure = new ActivityError("sendNotification", "notify failed", cause);
    const seen: unknown[] = [];

    await expect(bestEffort(ErrAsync(failure), (f) => seen.push(f))).resolves.toBeUndefined();
    expect(seen).toEqual([failure]);
  });

  it("hands a defect's cause to onFailure rather than rethrowing it", async () => {
    // A best-effort call has already been declared non-critical: a bug in the
    // notification path must not block an outcome that is already decided.
    const cause = new TypeError("cannot read properties of undefined");
    const seen: unknown[] = [];

    await expect(
      bestEffort(
        OkAsync(undefined).map(() => {
          throw cause;
        }),
        (f) => seen.push(f),
      ),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([cause]);
  });

  it("re-raises a cancelled ACTIVITY call instead of absorbing it", async () => {
    // The reason this helper exists. Absorbing cancellation would let the
    // workflow run on to Completed after someone asked it to stop.
    const cancelledFailure = ApplicationFailure.create({ message: "cancelled" });
    const cancelled = new ActivityCancelledError("sendNotification", cancelledFailure);
    const seen: unknown[] = [];

    await expect(bestEffort(ErrAsync(cancelled), (f) => seen.push(f))).rejects.toBe(
      cancelledFailure,
    );
    expect(seen).toEqual([]);
  });

  it("re-raises a cancelled CHILD WORKFLOW call", async () => {
    const cancelledFailure = ApplicationFailure.create({ message: "cancelled" });
    const cancelled = new ChildWorkflowCancelledError("childOrder", cancelledFailure);
    const seen: unknown[] = [];

    await expect(bestEffort(ErrAsync(cancelled), (f) => seen.push(f))).rejects.toBe(
      cancelledFailure,
    );
    expect(seen).toEqual([]);
  });

  it("re-raises a cancelled SCOPE", async () => {
    const cancelledFailure = ApplicationFailure.create({ message: "cancelled" });
    const cancelled = new WorkflowCancelledError(cancelledFailure);
    const seen: unknown[] = [];

    await expect(bestEffort(ErrAsync(cancelled), (f) => seen.push(f))).rejects.toBe(
      cancelledFailure,
    );
    expect(seen).toEqual([]);
  });
});
