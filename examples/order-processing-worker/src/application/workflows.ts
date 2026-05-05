import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { log } from "@temporalio/workflow";
import { orderProcessingContract } from "@temporal-contract/sample-order-processing-contract";

/**
 * Process Order Workflow Implementation
 *
 * - Activities use neverthrow's `ResultAsync` in their implementation
 *   (domain + infrastructure).
 * - Workflow checks activity results and returns appropriate status.
 * - No exceptions thrown — pure functional style with explicit return values.
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
 * 1. Log order start
 * 2. Process payment → if failed, return early
 * 3. Reserve inventory → if failed, refund payment and return
 * 4. Create shipment
 * 5. Send confirmation
 * 6. Return success status
 */
export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderProcessingContract,
  implementation: async (context, order) => {
    const { activities, info } = context;

    // State tracking for rollback
    let paymentTransactionId: string | undefined;

    // Step 1: Log order start
    log.info(`Starting order processing for ${order.orderId} (workflow: ${info.workflowId})`);

    // Step 2: Process payment
    log.info(`Processing payment of $${order.totalAmount}`);

    const paymentResult = await activities.processPayment({
      customerId: order.customerId,
      amount: order.totalAmount,
    });

    // Check payment status — return early if failed
    if (paymentResult.status === "failed") {
      log.error("Payment failed: card declined");

      await activities.sendNotification({
        customerId: order.customerId,
        subject: "Order Failed",
        message: `We're sorry, but your order ${order.orderId} could not be processed. Your payment was declined.`,
      });

      return {
        orderId: order.orderId,
        status: "failed" as const,
        failureReason: "Payment was declined",
        errorCode: "PAYMENT_FAILED",
      };
    }

    paymentTransactionId = paymentResult.transactionId;
    log.info(`Payment successful: ${paymentTransactionId}`);

    // Step 3: Reserve inventory
    log.info("Reserving inventory");
    const inventoryResult = await activities.reserveInventory(order.items);

    // Check inventory — rollback payment if failed
    if (!inventoryResult.reserved) {
      log.error("Inventory reservation failed");

      // Rollback: Refund payment
      log.info("Rolling back: refunding payment");
      await activities.refundPayment(paymentTransactionId);
      log.info(`Payment refunded: ${paymentTransactionId}`);

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

    // Step 4: Create shipment
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
      // Non-critical: log but continue
      log.warn(`Failed to send confirmation notification: ${error}`);
    }

    // Success!
    log.info(`Order ${order.orderId} processed successfully`);

    return {
      orderId: order.orderId,
      status: "completed" as const,
      transactionId: paymentTransactionId,
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
