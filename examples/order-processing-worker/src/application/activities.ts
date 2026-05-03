import { Future, Result } from "@swan-io/boxed";
import { declareActivitiesHandler, ActivityError } from "@temporal-contract/worker/activity";
import { orderProcessingContract } from "@temporal-contract/sample-order-processing-contract";
import {
  loggerAdapter,
  sendNotificationUseCase,
  processPaymentUseCase,
  reserveInventoryUseCase,
  releaseInventoryUseCase,
  createShipmentUseCase,
  refundPaymentUseCase,
} from "../dependencies.js";

/**
 * Activity implementations using the Result/Future pattern from @swan-io/boxed
 *
 * Instead of throwing exceptions, activities return:
 *   - Result.Ok(value) for success
 *   - Result.Error(ActivityError) for failures
 *
 * All technical exceptions MUST be caught and wrapped in ActivityError.
 * This ensures proper retry policies and error handling in Temporal.
 *
 * Benefits:
 *   - Explicit error types in function signatures
 *   - Better testability (no try/catch needed)
 *   - Functional composition with map/flatMap/match
 *   - Type-safe error handling
 *   - Controlled retry behavior via ActivityError
 */

// ============================================================================
// Activities Handler
// ============================================================================

/**
 * Create the activities handler with Result/Future pattern
 * Activities are thin wrappers that delegate to use cases
 * All activities return Future<Result<T, ActivityError>>
 *
 * Domain errors are wrapped in ActivityError to enable Temporal retry policies.
 */
export const activities = declareActivitiesHandler({
  contract: orderProcessingContract,
  activities: {
    log: ({ level, message }) => {
      loggerAdapter.log(level, message);
      return Future.value(Result.Ok(undefined));
    },

    sendNotification: ({ customerId, subject, message }) => {
      return Future.fromPromise(
        sendNotificationUseCase.execute(customerId, subject, message),
      ).mapError(
        (error) =>
          new ActivityError(
            "NOTIFICATION_FAILED",
            error instanceof Error ? error.message : "Failed to send notification",
            { cause: error },
          ),
      );
    },

    processOrder: {
      processPayment: ({ customerId, amount }) => {
        return Future.fromPromise(processPaymentUseCase.execute(customerId, amount)).mapError(
          (error) =>
            new ActivityError(
              "PAYMENT_FAILED",
              error instanceof Error ? error.message : "Payment processing failed",
              { cause: error },
            ),
        );
      },

      reserveInventory: (items) => {
        return Future.fromPromise(reserveInventoryUseCase.execute(items)).mapError(
          (error) =>
            new ActivityError(
              "INVENTORY_RESERVATION_FAILED",
              error instanceof Error ? error.message : "Inventory reservation failed",
              { cause: error },
            ),
        );
      },

      releaseInventory: (reservationId) => {
        return Future.fromPromise(releaseInventoryUseCase.execute(reservationId)).mapError(
          (error) =>
            new ActivityError(
              "INVENTORY_RELEASE_FAILED",
              error instanceof Error ? error.message : "Inventory release failed",
              { cause: error },
            ),
        );
      },

      createShipment: ({ orderId, customerId }) => {
        return Future.fromPromise(createShipmentUseCase.execute(orderId, customerId)).mapError(
          (error) =>
            new ActivityError(
              "SHIPMENT_CREATION_FAILED",
              error instanceof Error ? error.message : "Shipment creation failed",
              { cause: error },
            ),
        );
      },

      refundPayment: (transactionId) => {
        return Future.fromPromise(refundPaymentUseCase.execute(transactionId)).mapError(
          (error) =>
            new ActivityError(
              "REFUND_FAILED",
              error instanceof Error ? error.message : "Refund failed",
              { cause: error },
            ),
        );
      },
    },
  },
});
