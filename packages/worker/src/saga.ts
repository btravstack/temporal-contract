import { ContractError } from "@temporal-contract/contract/errors";
import { CancellationScope, inWorkflowContext } from "@temporalio/workflow";
/**
 * A saga for workflow code: a sequence of steps whose compensations are
 * unwound LIFO when a later step fails.
 *
 * The LIFO machinery is `@unthrown/saga`'s. What this module adds is the one
 * decision that belongs to Temporal rather than to a `Result` combinator:
 * **which failures compensate.**
 */
import { SagaAsync, type SagaAsyncBuilder } from "@unthrown/saga";
import { type AsyncResult, fromSafePromise, OkAsync, type Result } from "unthrown";

import {
  ActivityCancelledError,
  ChildWorkflowCancelledError,
  WorkflowCancelledError,
} from "./errors.js";

/** What a step or an undo may hand back: a `Result`, or an `AsyncResult`. */
type Produced<T, E> = Result<T, E> | AsyncResult<T, E>;

/** Options for {@link workflowSaga}. */
export type WorkflowSagaOptions = {
  /**
   * Also compensate when a step fails because the workflow, an activity or a
   * child workflow was **cancelled**.
   *
   * @remarks
   * Off by default: a cancelled step stopped at a point nobody observed, so
   * un-doing what it may or may not have done is a second bug. Turn it on for
   * a workflow whose steps hold something a cancellation must release anyway —
   * a seat, a reservation, a lock.
   *
   * @defaultValue false
   */
  readonly compensateOnCancellation?: boolean;
};

/**
 * The builder {@link workflowSaga} returns.
 *
 * @typeParam T - what the last step produced, and what `run()` answers.
 * @typeParam E - the union of every step's modeled error type.
 */
export type WorkflowSagaBuilder<T, E> = {
  /**
   * Add a step, with the undo that takes it back.
   *
   * @remarks
   * `run` is a **thunk** and takes no argument; `undo` receives the value its
   * own step produced. Either may answer a plain `Result` in place of an
   * `AsyncResult`, so an undo is written as the ordinary activity call it is.
   *
   * The undo runs only when the failure that triggered the unwind is one the
   * policy compensates — see {@link workflowSaga}. A compensation that itself
   * **fails** becomes a defect carrying its own failure, which takes
   * precedence over the failure that triggered the unwind and fails the
   * workflow loudly: a refund that never happened is worse news than the
   * order that could not ship. The remaining undos still run first.
   */
  readonly step: <T2, E2, U = unknown, E3 = unknown>(
    run: () => Produced<T2, E2>,
    undo?: (value: T2) => Produced<U, E3>,
  ) => WorkflowSagaBuilder<T2, E | E2>;
  /** Run the steps in order, unwinding LIFO on a failure the policy compensates. */
  readonly run: () => AsyncResult<T, E>;
};

/**
 * Whether a failure is one the walk-back may act on.
 *
 * A **declared contract error** is a permanent domain answer: the step ran, it
 * said no, and what it did before saying no is knowable — compensate. Every
 * other failure is not. An activity that failed unmodelled, or a child
 * workflow that did, left state nobody can see, and a defect is a bug rather
 * than an answer; un-deciding what you cannot see is a second bug, so the
 * failure propagates untouched and `propagateFailure` still re-raises
 * the platform's original failure.
 *
 * Cancellation is the one case a caller may opt back in to.
 */
const compensates = (error: unknown, onCancellation: boolean): boolean =>
  error instanceof ContractError ||
  (onCancellation &&
    (error instanceof ActivityCancelledError ||
      error instanceof ChildWorkflowCancelledError ||
      error instanceof WorkflowCancelledError));

/**
 * Run a compensation, and make its own failure the loudest thing that
 * happened. A defect is how the primitive spells "this outranks the failure
 * that triggered the unwind", and it is what Temporal should see: an operator
 * has to know a rollback did not roll back.
 */
const loudly = <U, E3>(undo: () => Produced<U, E3>): AsyncResult<void, never> =>
  fromSafePromise(async () => {
    // The undo and the activity it schedules both go inside the
    // non-cancellable scope. A cancelled scope schedules nothing — the SDK
    // rejects the call at once — so a compensation run inside one would
    // report `ActivityCancelledError` and never actually compensate, which
    // would leave `compensateOnCancellation` unable to do the one thing it
    // exists for. Outside a workflow (a saga composed in a unit test) there
    // is no scope to enter.
    const settled = await (inWorkflowContext()
      ? CancellationScope.nonCancellable(async () => await undo())
      : undo());
    if (settled.isOk()) return;
    // oxlint-disable-next-line unthrown/no-throw -- `Defect` has no public constructor, and a throw inside a combinator is the only way to mint one; the cause is the compensation's own failure, unwrapped
    throw settled.isErr() ? settled.error : settled.cause;
  });

/**
 * Open a saga whose undos run only on a failure the policy compensates.
 *
 * @remarks
 * Pure control flow — no timers, no clock, no randomness — so it replays
 * deterministically inside the workflow sandbox. The failure comes back
 * **unchanged**, so a caller triages exactly what it would have without the
 * saga.
 *
 * @example
 * ```ts
 * const fulfilled = await context
 *   .saga()
 *   .step(
 *     () => context.activities.reserveStock(order),
 *     (reservation) => context.activities.releaseStock({ id: reservation.id }),
 *   )
 *   .step(
 *     () => context.activities.chargeCard(order),
 *     (charge) => context.activities.refund({ id: charge.id }),
 *   )
 *   .step(() => context.activities.ship(order))
 *   .run();
 * ```
 */
export function workflowSaga(options?: WorkflowSagaOptions): WorkflowSagaBuilder<undefined, never> {
  const onCancellation = options?.compensateOnCancellation ?? false;

  // The failure of the step that just failed, which is the one the unwind is
  // reacting to. Local to this saga, so a replay rebuilds it from the same
  // steps in the same order.
  let failure: unknown = undefined;

  const wrap = <T, E>(inner: SagaAsyncBuilder<T, E>): WorkflowSagaBuilder<T, E> => ({
    step: <T2, E2, U = unknown, E3 = unknown>(
      run: () => Produced<T2, E2>,
      undo?: (value: T2) => Produced<U, E3>,
    ) =>
      wrap(
        inner.step(
          () =>
            run().tapFailure((f) => {
              failure = f.isErr() ? f.error : f.cause;
            }),
          undo === undefined
            ? undefined
            : (value: T2) =>
                compensates(failure, onCancellation) ? loudly(() => undo(value)) : OkAsync(),
        ),
      ),
    run: () => inner.run(),
  });

  return wrap(SagaAsync());
}
