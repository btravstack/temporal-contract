import { ContractError } from "@temporal-contract/contract/errors";
import { ApplicationFailure, ActivityFailure, RetryState } from "@temporalio/common";
import { ErrAsync, OkAsync } from "unthrown";
import { describe, expect, it } from "vitest";

import { propagateActivityFailure } from "./activity-failure.js";
import { ActivityCancelledError, ActivityError } from "./errors.js";

describe("propagateActivityFailure", () => {
  it("returns the value on Ok", async () => {
    await expect(propagateActivityFailure(OkAsync({ ok: true }))).resolves.toEqual({ ok: true });
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

    await expect(propagateActivityFailure(ErrAsync(activityError))).rejects.toBe(wrapper);
  });

  it("falls back to cause when no originalFailure was preserved", async () => {
    const cause = ApplicationFailure.create({ message: "boom", type: "Boom" });
    const activityError = new ActivityError("charge", 'Activity "charge" failed: boom', cause);

    await expect(propagateActivityFailure(ErrAsync(activityError))).rejects.toBe(cause);
  });

  it("rethrows the wrapper itself when neither cause nor originalFailure was preserved", async () => {
    // Never lose the error identity: if there is nothing underneath, the
    // ActivityError itself is the most informative thing available.
    const activityError = new ActivityError("charge", 'Activity "charge" failed: opaque');

    await expect(propagateActivityFailure(ErrAsync(activityError))).rejects.toBe(activityError);
  });

  it("rethrows the preserved cause for a cancelled activity", async () => {
    // ActivityCancelledError has no separate originalFailure: cancellation is
    // detected before classifyActivityError's unwrap, so cause already holds
    // the pre-unwrap original failure — see the class's doc comment.
    const cancelledFailure = ApplicationFailure.create({ message: "cancelled", type: "Cancelled" });
    const cancelled = new ActivityCancelledError("charge", cancelledFailure);

    await expect(propagateActivityFailure(ErrAsync(cancelled))).rejects.toBe(cancelledFailure);
  });

  it("rethrows a cancelled activity's wrapper when no cause was preserved", async () => {
    const cancelled = new ActivityCancelledError("charge");

    await expect(propagateActivityFailure(ErrAsync(cancelled))).rejects.toBe(cancelled);
  });

  it("rethrows a non-ActivityError error value unchanged", async () => {
    const other = new Error("something else");
    await expect(propagateActivityFailure(ErrAsync(other))).rejects.toBe(other);
  });

  it("rethrows the ApplicationFailure cause for a declared ContractError, not the TaggedError wrapper", async () => {
    // A declared contract error is ALSO a TaggedError, not a TemporalFailure
    // — the exact stall this helper exists to prevent (Fix round 1, Important
    // 1). classifyActivityError rehydrates it straight from the
    // ApplicationFailure Temporal put on the wire, so `cause` is what must
    // escape — not the ContractError wrapper itself.
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
    await expect(propagateActivityFailure(ErrAsync(contractError))).rejects.toBe(wireFailure);
  });

  it("rethrows a ContractError itself when no cause was set", async () => {
    const contractError = new ContractError({
      errorName: "PaymentDeclined",
      data: undefined,
      message: "Card declined",
    });

    await expect(propagateActivityFailure(ErrAsync(contractError))).rejects.toBe(contractError);
  });
});
