import { ContractError } from "@temporal-contract/contract/errors";
import { ErrAsync, Ok, OkAsync } from "unthrown";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ActivityCancelledError,
  ActivityError,
  ChildWorkflowCancelledError,
  WorkflowCancelledError,
} from "./errors.js";
import { workflowSaga, type WorkflowSagaBuilder } from "./saga.js";

/** A declared contract error — the failure the walk-back exists for. */
const outOfStock = () =>
  new ContractError({ errorName: "OutOfStock", data: { sku: "s-1" }, message: "out of stock" });

/**
 * Three steps, the third failing with `failure`, recording every undo that
 * runs. The shape every policy case below shares.
 */
const threeSteps = (failure: unknown, options?: { compensateOnCancellation: boolean }) => {
  const undone: string[] = [];
  const settled = workflowSaga(options)
    .step(
      () => OkAsync("reservation"),
      () => {
        undone.push("release");
        return OkAsync();
      },
    )
    .step(
      () => OkAsync("charge"),
      () => {
        undone.push("refund");
        return OkAsync();
      },
    )
    .step(
      () => ErrAsync(failure),
      () => {
        undone.push("unship");
        return OkAsync();
      },
    )
    .run();
  return { undone, settled };
};

describe("workflowSaga", () => {
  it("answers the last step's value when every step succeeds", async () => {
    // GIVEN a saga whose steps all succeed
    const saga = workflowSaga()
      .step(() => OkAsync("reservation"))
      .step(() => OkAsync({ shipmentId: "sh-1" }));

    // WHEN it runs
    // THEN the last step's value comes back
    await expect(saga.run()).toBeOkWith({ shipmentId: "sh-1" });
  });

  it("unwinds LIFO on a declared contract error, skipping the failed step's own undo", async () => {
    // GIVEN three steps, the third failing with a declared contract error
    const { undone, settled } = threeSteps(outOfStock());

    // WHEN the saga runs
    await settled;

    // THEN the two earned undos ran newest-first, and the failed step's did not
    expect(undone).toEqual(["refund", "release"]);
  });

  it("answers a declared contract error unchanged", async () => {
    // GIVEN a saga failing with a declared contract error
    const failure = outOfStock();

    // WHEN it runs
    const { settled } = threeSteps(failure);

    // THEN the failure comes back as it was, for the caller to triage
    await expect(settled).toBeErrWith(failure);
  });

  it("runs no undo when an activity failed unmodelled", async () => {
    // GIVEN a saga whose third step fails with the machinery's ActivityError
    const { undone, settled } = threeSteps(new ActivityError("ship", "boom"));

    // WHEN it runs
    await settled;

    // THEN nothing is taken back — that step's state is not knowable
    expect(undone).toEqual([]);
  });

  it("runs no undo on a cancelled activity by default", async () => {
    // GIVEN a saga whose third step was cancelled, with no opt-in
    const { undone, settled } = threeSteps(new ActivityCancelledError("ship"));

    // WHEN it runs
    await settled;

    // THEN nothing is taken back
    expect(undone).toEqual([]);
  });

  it("unwinds a cancelled activity when the caller opts in", async () => {
    // GIVEN the same cancellation, with compensateOnCancellation
    const { undone, settled } = threeSteps(new ActivityCancelledError("ship"), {
      compensateOnCancellation: true,
    });

    // WHEN it runs
    await settled;

    // THEN the undos run, newest first
    expect(undone).toEqual(["refund", "release"]);
  });

  it("unwinds a cancelled child workflow when the caller opts in", async () => {
    // GIVEN a child-workflow cancellation, with compensateOnCancellation
    const { undone, settled } = threeSteps(new ChildWorkflowCancelledError("fulfil", "wf-1"), {
      compensateOnCancellation: true,
    });

    // WHEN it runs
    await settled;

    // THEN the undos run
    expect(undone).toEqual(["refund", "release"]);
  });

  it("unwinds a cancelled workflow when the caller opts in", async () => {
    // GIVEN a workflow cancellation, with compensateOnCancellation
    const { undone, settled } = threeSteps(new WorkflowCancelledError(), {
      compensateOnCancellation: true,
    });

    // WHEN it runs
    await settled;

    // THEN the undos run
    expect(undone).toEqual(["refund", "release"]);
  });

  it("runs no undo on a defect", async () => {
    // GIVEN a step that throws — an unmodelled failure, not a domain answer
    const undone: string[] = [];
    const settled = workflowSaga()
      .step(
        () => OkAsync("reservation"),
        () => {
          undone.push("release");
          return OkAsync();
        },
      )
      .step(() => {
        // oxlint-disable-next-line unthrown/no-throw -- the throw IS the case under test: an unmodelled failure must not compensate
        throw new Error("boom");
      })
      .run();
    await settled;

    // WHEN/THEN nothing is taken back
    expect(undone).toEqual([]);
  });

  it("answers a failed compensation as a defect that outranks the triggering failure", async () => {
    // GIVEN a saga whose second undo fails while unwinding a declared error
    const refundFailed = new ActivityError("refund", "the gateway is down");
    const undone: string[] = [];
    const settled = workflowSaga()
      .step(
        () => OkAsync("reservation"),
        () => {
          undone.push("release");
          return OkAsync();
        },
      )
      .step(
        () => OkAsync("charge"),
        () => ErrAsync(refundFailed),
      )
      .step(() => ErrAsync(outOfStock()))
      .run();

    // WHEN it runs
    // THEN the rollback's own failure is what comes back, not the one that
    // triggered it — and the remaining undo still ran
    await expect(settled).toBeDefectWith(refundFailed);
    expect(undone).toEqual(["release"]);
  });

  it("accepts a synchronous Result from a step and its undo", async () => {
    // GIVEN a saga spelled entirely with sync Results
    const undone: string[] = [];
    const settled = workflowSaga()
      .step(
        () => Ok("reservation"),
        () => {
          undone.push("release");
          return Ok();
        },
      )
      .step(() => ErrAsync(outOfStock()))
      .run();

    // WHEN it runs
    await settled;

    // THEN the sync undo ran — no toAsync() needed
    expect(undone).toEqual(["release"]);
  });

  it("runs nothing until run() is called", async () => {
    // GIVEN a saga that is built but not run
    const ran: string[] = [];
    const saga = workflowSaga().step(() => {
      ran.push("step");
      return OkAsync(1);
    });

    // WHEN nothing awaits it
    // THEN the step has not started — every argument is a thunk
    expect(ran).toEqual([]);
    await saga.run();
  });

  it("types run() as the last step's value and the union of every step's error", () => {
    // GIVEN a saga over two failable steps
    const saga = workflowSaga()
      .step(() => ErrAsync<"e1">("e1").map(() => "reservation"))
      .step(() => ErrAsync<"e2">("e2").map(() => 1));

    // WHEN its type is read
    // THEN the value is the last step's and the errors union
    expectTypeOf(saga).toEqualTypeOf<WorkflowSagaBuilder<number, "e1" | "e2">>();
  });
});
