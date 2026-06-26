import { fromPromise } from "unthrown";
import { declareActivitiesHandler, ApplicationFailure } from "@temporal-contract/worker/activity";
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
 * Translate an arbitrary thrown value into a Temporal `ApplicationFailure`.
 * Used by every activity below to wrap use-case rejections in the
 * `err(...)` slot without each site repeating the boilerplate.
 */
const toApplicationFailure = (type: string, fallback: string, error: unknown): ApplicationFailure =>
  ApplicationFailure.create({
    type,
    message: error instanceof Error ? error.message : fallback,
    ...(error instanceof Error ? { cause: error } : {}),
  });

/**
 * Activity implementations using unthrown's `AsyncResult` pattern.
 *
 * Instead of throwing exceptions, activities return:
 *   - ok(value).toAsync() for success
 *   - err(ApplicationFailure).toAsync() for failures (or a `fromPromise`
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
      fromPromise(sendNotificationUseCase.execute(customerId, subject, message), (error) =>
        toApplicationFailure("NOTIFICATION_FAILED", "Failed to send notification", error),
      ),

    processOrder: {
      processPayment: ({ customerId, amount }) =>
        fromPromise(processPaymentUseCase.execute(customerId, amount), (error) =>
          toApplicationFailure("PAYMENT_FAILED", "Payment processing failed", error),
        ),

      reserveInventory: (items) =>
        fromPromise(reserveInventoryUseCase.execute(items), (error) =>
          toApplicationFailure(
            "INVENTORY_RESERVATION_FAILED",
            "Inventory reservation failed",
            error,
          ),
        ),

      releaseInventory: (reservationId) =>
        fromPromise(releaseInventoryUseCase.execute(reservationId), (error) =>
          toApplicationFailure("INVENTORY_RELEASE_FAILED", "Inventory release failed", error),
        ),

      createShipment: ({ orderId, customerId }) =>
        fromPromise(createShipmentUseCase.execute(orderId, customerId), (error) =>
          toApplicationFailure("SHIPMENT_CREATION_FAILED", "Shipment creation failed", error),
        ),

      refundPayment: (transactionId) =>
        fromPromise(refundPaymentUseCase.execute(transactionId), (error) =>
          toApplicationFailure("REFUND_FAILED", "Refund failed", error),
        ),
    },
  },
});
