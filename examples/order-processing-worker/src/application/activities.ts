import { fromPromise } from "unthrown";
import { declareActivitiesHandler, qualify } from "@temporal-contract/worker/activity";
import { orderProcessingContract } from "@temporal-contract/sample-order-processing-contract";
import {
  sendNotificationUseCase,
  processPaymentUseCase,
  reserveInventoryUseCase,
  releaseInventoryUseCase,
  createShipmentUseCase,
  refundPaymentUseCase,
} from "../dependencies.js";

/**
 * Activity implementations using unthrown's `AsyncResult` pattern.
 *
 * Instead of throwing exceptions, activities return:
 *   - Ok(value).toAsync() for success
 *   - Err(ApplicationFailure).toAsync() for failures (or a `fromPromise`
 *     chain that qualifies a rejection into an `ApplicationFailure`).
 *
 * All technical exceptions MUST be caught and wrapped in `ApplicationFailure`
 * (Temporal's first-class failure shape, re-exported from
 * `@temporal-contract/worker/activity` for convenience). Per-instance
 * `nonRetryable: true` opts a specific failure out of the configured
 * retry policy.
 *
 * Benefits:
 *   - Explicit error types in function signatures
 *   - Per-instance `nonRetryable` flag for permanent failures
 *   - Functional composition with map/flatMap/match
 *   - Native Temporal serialization across the activity → workflow boundary
 */

// ============================================================================
// Activities Handler
// ============================================================================

/**
 * Create the activities handler with unthrown's AsyncResult pattern.
 * Activities are thin wrappers that delegate to use cases.
 * All activities return `AsyncResult<T, ApplicationFailure>`.
 *
 * Domain errors are wrapped in `ApplicationFailure` so Temporal applies the
 * configured retry policy. Set `nonRetryable: true` for permanent failures
 * (e.g. validation rejections, insufficient funds).
 */
export const activities = declareActivitiesHandler({
  contract: orderProcessingContract,
  activities: {
    sendNotification: ({ customerId, subject, message }) =>
      fromPromise(
        sendNotificationUseCase.execute(customerId, subject, message),
        qualify("NOTIFICATION_FAILED", { message: "Failed to send notification" }),
      ),

    processOrder: {
      processPayment: ({ customerId, amount }) =>
        fromPromise(
          processPaymentUseCase.execute(customerId, amount),
          qualify("PAYMENT_FAILED", { message: "Payment processing failed" }),
        ),

      reserveInventory: (items) =>
        fromPromise(
          reserveInventoryUseCase.execute(items),
          qualify("INVENTORY_RESERVATION_FAILED", { message: "Inventory reservation failed" }),
        ),

      releaseInventory: (reservationId) =>
        fromPromise(
          releaseInventoryUseCase.execute(reservationId),
          qualify("INVENTORY_RELEASE_FAILED", { message: "Inventory release failed" }),
        ),

      createShipment: ({ orderId, customerId }) =>
        fromPromise(
          createShipmentUseCase.execute(orderId, customerId),
          qualify("SHIPMENT_CREATION_FAILED", { message: "Shipment creation failed" }),
        ),

      refundPayment: (transactionId) =>
        fromPromise(
          refundPaymentUseCase.execute(transactionId),
          qualify("REFUND_FAILED", { message: "Refund failed" }),
        ),
    },
  },
});
