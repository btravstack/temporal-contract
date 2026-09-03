import {
  orderProcessingContract,
  type OrderStatusSchema,
} from "@temporal-contract/sample-order-processing-contract";
import {
  ACTIVITY_CANCELLED_ERROR_TAG,
  ACTIVITY_ERROR_TAG,
  declareWorkflow,
  propagateFailure,
  rethrowCancellation,
} from "@temporal-contract/worker/workflow";
import { condition, log } from "@temporalio/workflow";
import { P } from "unthrown";
import type { z } from "zod";

type OrderStatus = z.infer<typeof OrderStatusSchema>;

/**
 * Orders above this amount wait for a human `approveOrder` signal before
 * payment. A constant keeps the decision deterministic across replays.
 */
const APPROVAL_THRESHOLD = 100;

/**
 * How long a high-value order waits for approval before failing.
 */
const APPROVAL_TIMEOUT = "5 minutes";

/**
 * Process Order Workflow Implementation
 *
 * - Signal/query handlers are registered up front via `context.handleSignal`
 *   / `context.handleQuery`, closing over plain workflow-local state — the
 *   deterministic way to expose interactive state.
 * - Activities use unthrown's `AsyncResult` in their implementation
 *   (domain + infrastructure). `processPayment` declares a contract error,
 *   so its workflow-side call returns an `AsyncResult` whose error channel
 *   carries the typed `PaymentDeclined` (plus the generic activity errors).
 * - That error channel is folded once, at the call site, with
 *   `match({ ok, errCases, defect })`: a declined payment is rethrown as
 *   this workflow's own declared contract error
 *   (`context.errors.PaymentDeclined`) so the typed client rehydrates it,
 *   cancellation is re-raised with `rethrowCancellation` so the execution
 *   ends `Cancelled`, an undeclared activity failure becomes a "failed"
 *   order result, and a defect fails the Workflow Task.
 *
 * Determinism note: everything here is replay-safe — `condition` and `log`
 * come from `@temporalio/workflow`, signal/query state is plain local data,
 * and every side effect goes through an activity.
 *
 * Logging note: this workflow uses the `log` namespace from
 * `@temporalio/workflow` (replay-safe, routed through the worker's
 * configured logger sink). It does **not** define a `log` Temporal
 * activity — calling an activity per log line would inflate workflow
 * history (every line becomes a recorded event), cost money on Temporal
 * Cloud, and replay on every recovery. Workflow logs go through `log.*`;
 * domain effects go through activities.
 *
 * Flow:
 * 1. Register signal handlers (`approveOrder`, `cancelRequested`) and the
 *    `getOrderStatus` query
 * 2. High-value orders wait for approval (or cancellation / timeout)
 * 3. Process payment → declined ⇒ notify + throw typed `PaymentDeclined`
 * 4. Reserve inventory → if failed, refund payment and return
 * 5. Create shipment
 * 6. Send confirmation
 * 7. Return success status
 */
export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderProcessingContract,
  implementation: async (context, order) => {
    const { activities, info } = context;

    // ------------------------------------------------------------------
    // Interactive state: driven by signals, read by the query.
    // ------------------------------------------------------------------
    let status: OrderStatus =
      order.totalAmount > APPROVAL_THRESHOLD ? "awaiting_approval" : "processing_payment";
    let approvedBy: string | undefined;
    let cancelRequested = false;

    // Payload-carrying signal — the handler receives the schema-parsed input.
    context.handleSignal("approveOrder", (approval) => {
      approvedBy = approval.approvedBy;
      log.info(
        `Order ${order.orderId} approved by ${approval.approvedBy}` +
          (approval.note ? ` — ${approval.note}` : ""),
      );
    });

    // Payload-less signal (`defineSignal()` in the contract) — no arguments.
    context.handleSignal("cancelRequested", () => {
      cancelRequested = true;
      log.info(`Cancellation requested for order ${order.orderId}`);
    });

    // Argument-less query — must stay synchronous and side-effect free.
    // The optional field is spread in (never set to `undefined`) to satisfy
    // exactOptionalPropertyTypes.
    context.handleQuery("getOrderStatus", () => ({
      status,
      ...(approvedBy !== undefined ? { approvedBy } : {}),
    }));

    log.info(`Starting order processing for ${order.orderId} (workflow: ${info.workflowId})`);

    // ------------------------------------------------------------------
    // Step 1: approval gate for high-value orders
    // ------------------------------------------------------------------
    if (status === "awaiting_approval") {
      log.info(`Order ${order.orderId} exceeds $${APPROVAL_THRESHOLD} — awaiting approval signal`);

      // `condition` is Temporal's deterministic wait: it resumes when the
      // predicate flips (a signal arrived) or the timeout elapses (false).
      const decided = await condition(
        () => approvedBy !== undefined || cancelRequested,
        APPROVAL_TIMEOUT,
      );

      if (!decided) {
        status = "failed";
        log.error(`Order ${order.orderId} approval timed out`);
        return {
          orderId: order.orderId,
          status: "failed" as const,
          failureReason: `No approval received within ${APPROVAL_TIMEOUT}`,
          errorCode: "APPROVAL_TIMEOUT",
        };
      }
    }

    if (cancelRequested) {
      status = "cancelled";
      log.info(`Order ${order.orderId} cancelled before payment`);
      return {
        orderId: order.orderId,
        status: "cancelled" as const,
        failureReason: "Cancellation requested by the customer",
        errorCode: "CANCELLED",
      };
    }

    // ------------------------------------------------------------------
    // Step 2: process payment (activity with a declared contract error)
    // ------------------------------------------------------------------
    status = "processing_payment";
    log.info(`Processing payment of $${order.totalAmount}`);

    // `processPayment` declares `errors` in the contract, so the call returns
    // `AsyncResult<PaymentResult, PaymentDeclined | ActivityError |
    // ActivityCancelledError>` instead of a throwing Promise. Fold all three
    // channels once, at the call site — every arm either produces a value or
    // deliberately ends the workflow.
    const paymentOutcome = await activities
      .processPayment({ customerId: order.customerId, amount: order.totalAmount })
      .match({
        ok: (payment) => payment,
        errCases: (matcher) =>
          matcher
            // The only declared error on `processPayment` — the object
            // pattern narrows the shared-`_tag` `ContractError` union by
            // `errorName`, typing `failure.data` as `{ reason: string }`.
            .with({ errorName: "PaymentDeclined" }, async (failure) => {
              status = "failed";
              log.error(`Payment declined for order ${order.orderId}: ${failure.data.reason}`);

              // Best-effort notification: the declined-payment outcome below
              // is what matters, so an undeclared notification failure only
              // gets a warning — it must not swallow (or block) the rethrow.
              // Real cancellation is the exception: it must still propagate.
              await activities
                .sendNotification({
                  customerId: order.customerId,
                  subject: "Order Failed",
                  message: `We're sorry, but your order ${order.orderId} could not be processed. Your payment was declined (${failure.data.reason}).`,
                })
                .match({
                  ok: () => undefined,
                  errCases: (matcher) =>
                    matcher
                      .with(P.tag(ACTIVITY_CANCELLED_ERROR_TAG), (cancelled) =>
                        rethrowCancellation(cancelled),
                      )
                      .with(P.tag(ACTIVITY_ERROR_TAG), (notifyFailure) => {
                        log.warn(
                          `Failed to notify customer of declined payment: ${notifyFailure.message}`,
                        );
                      }),
                  // A defect here is still just a failed email — the
                  // PaymentDeclined outcome about to be rethrown below is
                  // already authoritative and must not be blocked by a
                  // notification bug.
                  defect: (cause) => {
                    log.warn(`Failed to notify customer of declined payment: ${cause}`);
                  },
                });

              // Rethrow as this workflow's own declared contract error: the
              // execution fails with `ApplicationFailure(type: "PaymentDeclined")`
              // and the typed client rehydrates it into a `ContractError`.
              // oxlint-disable-next-line unthrown/no-throw -- sanctioned ApplicationFailure model: `throw context.errors.X(...)` is how a workflow fails terminally with a typed contract error (CLAUDE.md rule 2 exception)
              throw context.errors.PaymentDeclined(
                { reason: failure.data.reason },
                { cause: failure },
              );
            })
            // Cancellation rides the modeled Err channel — mapping it to a
            // "failed" order would complete the workflow instead of honoring
            // the cancel. Re-raise it so the execution ends `Cancelled`.
            .with(P.tag(ACTIVITY_CANCELLED_ERROR_TAG), (failure) => rethrowCancellation(failure))
            // Undeclared activity failure (retries exhausted, timeout):
            // surface a failed order result.
            .with(P.tag(ACTIVITY_ERROR_TAG), (failure) => {
              status = "failed";
              log.error(`Payment activity failed for order ${order.orderId}: ${failure.message}`);
              return {
                orderId: order.orderId,
                status: "failed" as const,
                failureReason: "Payment could not be processed",
                errorCode: "PAYMENT_UNAVAILABLE",
              };
            }),
        // Unmodeled failure (a bug, not an anticipated outcome) — rethrow at
        // the edge so Temporal surfaces the Workflow Task failure.
        defect: (cause) => {
          // oxlint-disable-next-line unthrown/no-throw -- defect-cause rethrow at the edge: an unmodeled failure must surface as a Workflow Task failure
          throw cause;
        },
      });

    if ("status" in paymentOutcome) {
      // The fold produced the workflow's failed output — return it as-is.
      return paymentOutcome;
    }

    const payment = paymentOutcome;
    log.info(`Payment successful: ${payment.transactionId}`);

    // ------------------------------------------------------------------
    // Step 3: reserve inventory (rollback payment on failure)
    // ------------------------------------------------------------------
    status = "reserving_inventory";
    log.info("Reserving inventory");

    // `reserveInventory` declares no contract errors, but every activity call
    // now returns an `AsyncResult`, so a technical failure (retries
    // exhausted, timeout) still needs a decision. Fold it into the same
    // "not reserved" business outcome handled below — the rollback (refund +
    // notify) should run regardless of *why* inventory couldn't be reserved —
    // but carry `unavailable` through so the returned order result still
    // tells the truth about *which* outcome happened (see the `errorCode`
    // selection below): a technical fault must never be reported to the
    // client as a business "out of stock" decline, mirroring how
    // `processPayment` above keeps `PAYMENT_UNAVAILABLE` distinct from
    // `PaymentDeclined`. Real cancellation is the exception: it must still
    // propagate.
    const inventoryOutcome = await activities.reserveInventory(order.items).match({
      ok: (reservation) => ({ ...reservation, unavailable: false as const }),
      errCases: (matcher) =>
        matcher
          .with(P.tag(ACTIVITY_CANCELLED_ERROR_TAG), (cancelled) => rethrowCancellation(cancelled))
          .with(P.tag(ACTIVITY_ERROR_TAG), (failure) => {
            log.error(`Inventory reservation activity failed: ${failure.message}`);
            return { reserved: false as const, unavailable: true as const };
          }),
      // Unmodeled failure (a bug, not an anticipated outcome) — rethrow at
      // the edge so Temporal surfaces the Workflow Task failure.
      defect: (cause) => {
        // oxlint-disable-next-line unthrown/no-throw -- defect-cause rethrow at the edge: an unmodeled failure must surface as a Workflow Task failure
        throw cause;
      },
    });

    if (!inventoryOutcome.reserved) {
      status = "failed";
      // `unavailable` is only `true` on the technical-failure arm above — a
      // business decline (no stock) reports the activity's own `Ok` value,
      // which carries `unavailable: false`.
      const inventoryUnavailable = inventoryOutcome.unavailable === true;
      log.error(
        inventoryUnavailable
          ? "Inventory reservation activity failed"
          : "Inventory reservation failed",
      );

      // Rollback: refund the payment. Unlike the notifications in this
      // workflow, a failed refund is NOT worth a warning-and-continue: the
      // customer would be charged for an order that both failed and was
      // never refunded. That is exactly the case where Temporal should fail
      // the workflow loudly (visible, alertable) instead of completing it
      // with a routine "failed" order status. `propagateFailure`
      // restores the exact pre-uniform-`AsyncResult` behavior: before every
      // activity call returned a `Result`, an unhandled `refundPayment`
      // failure threw and failed this workflow outright — this is that same
      // outcome, made explicit instead of accidental.
      log.info("Rolling back: refunding payment");
      await propagateFailure(activities.refundPayment(payment.transactionId));
      log.info(`Payment refunded: ${payment.transactionId}`);

      // Best-effort notification — see the PaymentDeclined branch above for
      // the same reasoning: don't let an undeclared notification failure
      // block the "failed" order result, but do honor real cancellation.
      const rollbackMessage = inventoryUnavailable
        ? `We're sorry, but your order ${order.orderId} could not be processed. Our inventory service is temporarily unavailable. Any charges have been refunded.`
        : `We're sorry, but your order ${order.orderId} could not be processed. One or more items are out of stock. Any charges have been refunded.`;

      await activities
        .sendNotification({
          customerId: order.customerId,
          subject: "Order Failed",
          message: rollbackMessage,
        })
        .match({
          ok: () => undefined,
          errCases: (matcher) =>
            matcher
              .with(P.tag(ACTIVITY_CANCELLED_ERROR_TAG), (cancelled) =>
                rethrowCancellation(cancelled),
              )
              .with(P.tag(ACTIVITY_ERROR_TAG), (failure) => {
                log.warn(`Failed to notify customer of out-of-stock order: ${failure.message}`);
              }),
          // A defect here is still just a failed email — the order outcome
          // above (and about to be returned below) is already authoritative
          // and must not be blocked by a notification bug.
          defect: (cause) => {
            log.warn(`Failed to notify customer of out-of-stock order: ${cause}`);
          },
        });

      return {
        orderId: order.orderId,
        status: "failed" as const,
        failureReason: inventoryUnavailable
          ? "Inventory could not be reserved"
          : "One or more items are out of stock",
        errorCode: inventoryUnavailable ? "INVENTORY_UNAVAILABLE" : "OUT_OF_STOCK",
      };
    }

    log.info(`Inventory reserved: ${inventoryOutcome.reservationId}`);

    // ------------------------------------------------------------------
    // Step 4: create shipment
    // ------------------------------------------------------------------
    status = "creating_shipment";
    log.info("Creating shipment");

    // No rollback path exists for a failed shipment creation (unlike
    // inventory reservation above) — that is a genuine "let Temporal fail
    // the workflow" case, not a business outcome this example models.
    const shippingResult = await propagateFailure(
      activities.createShipment({
        orderId: order.orderId,
        customerId: order.customerId,
      }),
    );

    log.info(`Shipment created: ${shippingResult.trackingNumber}`);

    // Step 5: Send success notification (non-critical). Every activity call
    // now returns an `AsyncResult` — including cancellation, via
    // `ActivityCancelledError` — so narrowing the call's own result is enough
    // and no longer needs a wrapping `cancellableScope` just to observe it.
    await activities
      .sendNotification({
        customerId: order.customerId,
        subject: "Order Confirmed",
        message: `Your order ${order.orderId} has been confirmed and will be shipped. Tracking: ${shippingResult.trackingNumber}`,
      })
      .match({
        ok: () => undefined,
        // Cancellation must propagate — absorbing it here would complete the
        // workflow after a cancel request instead of ending it `Cancelled`.
        errCases: (matcher) =>
          matcher
            .with(P.tag(ACTIVITY_CANCELLED_ERROR_TAG), (cancelled) =>
              rethrowCancellation(cancelled),
            )
            // Non-critical: the order is already shipped, so even an
            // undeclared notification failure is only worth a warning.
            .with(P.tag(ACTIVITY_ERROR_TAG), (failure) => {
              log.warn(`Failed to send confirmation notification: ${failure.message}`);
            }),
        // A defect here is still just a failed email — the order already
        // completed successfully above, and that outcome is authoritative.
        defect: (cause) => {
          log.warn(`Failed to send confirmation notification: ${cause}`);
        },
      });

    // Success!
    status = "completed";
    log.info(`Order ${order.orderId} processed successfully`);

    return {
      orderId: order.orderId,
      status: "completed" as const,
      transactionId: payment.transactionId,
      trackingNumber: shippingResult.trackingNumber,
    };
  },
  activityOptions: {
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 3 },
  },
  // Per-activity overrides: payment-related activities talk to a slower
  // gateway and are worth retrying more aggressively, so they get a longer
  // timeout and a custom retry policy. Everything else uses the workflow
  // default above.
  activityOptionsByName: {
    processPayment: {
      startToCloseTimeout: "5 minutes",
      retry: { maximumAttempts: 5 },
    },
    refundPayment: {
      startToCloseTimeout: "5 minutes",
      retry: { maximumAttempts: 5 },
    },
  },
});

/**
 * Cleanup Expired Orders Workflow Implementation
 *
 * The schedule-driven counterpart to `processOrder` (see the client
 * example's `schedule.create` call). It only uses the global
 * `purgeExpiredOrders` activity — it declares no workflow-local activities,
 * so the activities handler needs no entry for it.
 */
export const cleanupExpiredOrders = declareWorkflow({
  workflowName: "cleanupExpiredOrders",
  contract: orderProcessingContract,
  activityOptions: {
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 3 },
  },
  implementation: async (context, { olderThanDays }) => {
    log.info(`Starting order cleanup (older than ${olderThanDays} days)`);

    // A scheduled cleanup job with no recovery path: a failed purge should
    // fail loudly (visible in the Temporal UI, the schedule runs again next
    // time) rather than being silently swallowed into a fake "0 purged"
    // success.
    const { purgedCount } = await propagateFailure(
      context.activities.purgeExpiredOrders({ olderThanDays }),
    );

    log.info(`Order cleanup finished: purged ${purgedCount} orders`);
    return { purgedCount };
  },
});
