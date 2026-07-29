import {
  orderProcessingContract,
  type OrderStatusSchema,
} from "@temporal-contract/sample-order-processing-contract";
import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { condition, isCancellation, log } from "@temporalio/workflow";
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
 * - Signal/query handlers are registered up front via `context.defineSignal`
 *   / `context.defineQuery`, closing over plain workflow-local state — the
 *   deterministic way to expose interactive state.
 * - Activities use unthrown's `AsyncResult` in their implementation
 *   (domain + infrastructure). `processPayment` declares a contract error,
 *   so its workflow-side call returns an `AsyncResult` whose error channel
 *   carries the typed `PaymentDeclined` (plus the generic activity errors).
 * - A declined payment is rethrown as this workflow's own declared contract
 *   error (`context.errors.PaymentDeclined`), so the typed client rehydrates
 *   it — the one failure path that is an *error*, not a "failed" result.
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
    context.defineSignal("approveOrder", (approval) => {
      approvedBy = approval.approvedBy;
      log.info(
        `Order ${order.orderId} approved by ${approval.approvedBy}` +
          (approval.note ? ` — ${approval.note}` : ""),
      );
    });

    // Payload-less signal (`defineSignal()` in the contract) — no arguments.
    context.defineSignal("cancelRequested", () => {
      cancelRequested = true;
      log.info(`Cancellation requested for order ${order.orderId}`);
    });

    // Argument-less query — must stay synchronous and side-effect free.
    // The optional field is spread in (never set to `undefined`) to satisfy
    // exactOptionalPropertyTypes.
    context.defineQuery("getOrderStatus", () => ({
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
    // ActivityCancelledError>` instead of a throwing Promise.
    const paymentResult = await activities.processPayment({
      customerId: order.customerId,
      amount: order.totalAmount,
    });

    if (!paymentResult.isOk()) {
      status = "failed";

      if (paymentResult.isDefect()) {
        // Unmodeled failure (a bug, not an anticipated outcome) — rethrow at
        // the edge so Temporal surfaces the Workflow Task failure.
        throw paymentResult.cause;
      }
      const failure = paymentResult.error;

      switch (failure._tag) {
        case "@temporal-contract/ContractError": {
          // The only declared error on `processPayment` is PaymentDeclined,
          // so `failure.data` is typed `{ reason: string }`.
          log.error(`Payment declined for order ${order.orderId}: ${failure.data.reason}`);

          await activities.sendNotification({
            customerId: order.customerId,
            subject: "Order Failed",
            message: `We're sorry, but your order ${order.orderId} could not be processed. Your payment was declined (${failure.data.reason}).`,
          });

          // Rethrow as this workflow's own declared contract error: the
          // execution fails with `ApplicationFailure(type: "PaymentDeclined")`
          // and the typed client rehydrates it into a `ContractError`.
          throw context.errors.PaymentDeclined({ reason: failure.data.reason }, { cause: failure });
        }
        case "@temporal-contract/ActivityError":
        case "@temporal-contract/ActivityCancelledError": {
          // Unclassified activity failure (retries exhausted, timeout,
          // cancellation): surface a failed order result.
          log.error(`Payment activity failed for order ${order.orderId}: ${failure.message}`);
          return {
            orderId: order.orderId,
            status: "failed" as const,
            failureReason: "Payment could not be processed",
            errorCode: "PAYMENT_UNAVAILABLE",
          };
        }
      }
    }

    const payment = paymentResult.value;
    log.info(`Payment successful: ${payment.transactionId}`);

    // ------------------------------------------------------------------
    // Step 3: reserve inventory (rollback payment on failure)
    // ------------------------------------------------------------------
    status = "reserving_inventory";
    log.info("Reserving inventory");
    const inventoryResult = await activities.reserveInventory(order.items);

    if (!inventoryResult.reserved) {
      status = "failed";
      log.error("Inventory reservation failed");

      // Rollback: Refund payment
      log.info("Rolling back: refunding payment");
      await activities.refundPayment(payment.transactionId);
      log.info(`Payment refunded: ${payment.transactionId}`);

      await activities.sendNotification({
        customerId: order.customerId,
        subject: "Order Failed",
        message: `We're sorry, but your order ${order.orderId} could not be processed. One or more items are out of stock. Any charges have been refunded.`,
      });

      return {
        orderId: order.orderId,
        status: "failed" as const,
        failureReason: "One or more items are out of stock",
        errorCode: "OUT_OF_STOCK",
      };
    }

    log.info(`Inventory reserved: ${inventoryResult.reservationId}`);

    // ------------------------------------------------------------------
    // Step 4: create shipment
    // ------------------------------------------------------------------
    status = "creating_shipment";
    log.info("Creating shipment");
    const shippingResult = await activities.createShipment({
      orderId: order.orderId,
      customerId: order.customerId,
    });

    log.info(`Shipment created: ${shippingResult.trackingNumber}`);

    // Step 5: Send success notification (non-critical)
    try {
      await activities.sendNotification({
        customerId: order.customerId,
        subject: "Order Confirmed",
        message: `Your order ${order.orderId} has been confirmed and will be shipped. Tracking: ${shippingResult.trackingNumber}`,
      });
    } catch (error) {
      // Cancellation must propagate — swallowing it here would leave the
      // workflow running after a cancel request.
      if (isCancellation(error)) {
        throw error;
      }
      // Non-critical: log but continue
      log.warn(`Failed to send confirmation notification: ${error}`);
    }

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
  },
  implementation: async (context, { olderThanDays }) => {
    log.info(`Starting order cleanup (older than ${olderThanDays} days)`);

    const { purgedCount } = await context.activities.purgeExpiredOrders({ olderThanDays });

    log.info(`Order cleanup finished: purged ${purgedCount} orders`);
    return { purgedCount };
  },
});
