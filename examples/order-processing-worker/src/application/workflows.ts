import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { orderProcessingContract } from "@temporal-contract/sample-order-processing-contract";

/**
 * Process Order Workflow Implementation
 *
 * This workflow demonstrates a different approach to error handling:
 * - Activities use neverthrow's ResultAsync in their implementation (domain + infrastructure)
 * - Workflow checks activity results and returns appropriate status
 * - No exceptions thrown - pure functional style with explicit return values
 *
 * Flow:
 * 1. Log order start
 * 2. Process payment -> if failed, return early
 * 3. Reserve inventory -> if failed, return early
 * 4. Create shipment
 * 5. Send confirmation
 * 6. Return success status
 *
 * Note: Activities internally use ResultAsync, but workflow code
 * stays deterministic by working with the unwrapped values.
 */
export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderProcessingContract,
  implementation: async (context, order) => {
    const { activities, info } = context;

    // State tracking for rollback
    let paymentTransactionId: string | undefined;
    let inventoryReservationId: string | undefined;

    // Step 1: Log order start
    await activities.log({
      level: "info",
      message: `Starting order processing for ${order.orderId} (workflow: ${info.workflowId})`,
    });

    // Step 2: Process payment
    await activities.log({
      level: "info",
      message: `Processing payment of $${order.totalAmount}`,
    });

    const paymentResult = await activities.processPayment({
      customerId: order.customerId,
      amount: order.totalAmount,
    });

    // Check payment status - return early if failed
    if (paymentResult.status === "failed") {
      await activities.log({
        level: "error",
        message: "Payment failed: Card declined",
      });

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
    await activities.log({
      level: "info",
      message: `Payment successful: ${paymentTransactionId}`,
    });

    // Step 3: Reserve inventory
    await activities.log({ level: "info", message: "Reserving inventory" });
    const inventoryResult = await activities.reserveInventory(order.items);

    // Check inventory - rollback payment if failed
    if (!inventoryResult.reserved) {
      await activities.log({
        level: "error",
        message: "Inventory reservation failed",
      });

      // Rollback: Refund payment
      await activities.log({ level: "info", message: "Rolling back: refunding payment" });
      await activities.refundPayment(paymentTransactionId);
      await activities.log({
        level: "info",
        message: `Payment refunded: ${paymentTransactionId}`,
      });

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

    inventoryReservationId = inventoryResult.reservationId;
    await activities.log({
      level: "info",
      message: `Inventory reserved: ${inventoryReservationId}`,
    });

    // Step 4: Create shipment
    await activities.log({ level: "info", message: "Creating shipment" });
    const shippingResult = await activities.createShipment({
      orderId: order.orderId,
      customerId: order.customerId,
    });

    await activities.log({
      level: "info",
      message: `Shipment created: ${shippingResult.trackingNumber}`,
    });

    // Step 5: Send success notification (non-critical)
    try {
      await activities.sendNotification({
        customerId: order.customerId,
        subject: "Order Confirmed",
        message: `Your order ${order.orderId} has been confirmed and will be shipped. Tracking: ${shippingResult.trackingNumber}`,
      });
    } catch (error) {
      // Non-critical: log but continue
      await activities.log({
        level: "warn",
        message: `Failed to send confirmation notification: ${error}`,
      });
    }

    // Success!
    await activities.log({
      level: "info",
      message: `Order ${order.orderId} processed successfully`,
    });

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
