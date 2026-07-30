import { orderProcessingContract } from "@temporal-contract/sample-order-processing-contract";
import { declareActivitiesHandler, qualifyFailure } from "@temporal-contract/worker/activity";
import { Err, Ok, fromPromise } from "unthrown";

import {
  sendNotificationUseCase,
  processPaymentUseCase,
  purgeExpiredOrdersUseCase,
  reserveInventoryUseCase,
  releaseInventoryUseCase,
  createShipmentUseCase,
  refundPaymentUseCase,
} from "../dependencies.js";

/**
 * Activity implementations using unthrown's `AsyncResult` pattern.
 *
 * Instead of throwing exceptions, activities return:
 *   - OkAsync(value) for success
 *   - ErrAsync(ApplicationFailure) for technical failures (or a
 *     `fromPromise` chain whose `qualifyFailure` wraps a rejection into an
 *     `ApplicationFailure`)
 *   - ErrAsync(errors.X(data)) for *declared* contract errors — the
 *     typed constructors arrive in the implementation's second (helpers)
 *     argument and surface to the calling workflow as typed `ContractError`s.
 *     (Sync `Ok(...)` / `Err(...)` stay valid inside combinator callbacks
 *     like `flatMap`, as below.)
 *
 * All technical exceptions MUST be caught and wrapped in `ApplicationFailure`
 * (Temporal's first-class failure shape, re-exported from
 * `@temporal-contract/worker/activity`). Per-instance `nonRetryable: true`
 * opts a specific failure out of the configured retry policy; for contract
 * errors, retryability comes from the contract's `errors` declaration.
 */

// ============================================================================
// Activities Handler
// ============================================================================

/**
 * Create the activities handler with unthrown's AsyncResult pattern.
 * Activities are thin wrappers that delegate to use cases.
 *
 * The implementation map mirrors the contract's structure: global activities
 * at the root, workflow-local activities nested under their workflow's name.
 * `cleanupExpiredOrders` declares no workflow-local activities, so it needs
 * no entry here — not even an empty `{}` placeholder.
 */
export const activities = declareActivitiesHandler({
  contract: orderProcessingContract,
  activities: {
    sendNotification: ({ customerId, subject, message }) =>
      fromPromise(
        sendNotificationUseCase.execute(customerId, subject, message),
        qualifyFailure("NOTIFICATION_FAILED", {
          // Anticipated failure shape: the domain layer signals technical
          // faults by throwing plain `Error`s. Anything else (a TypeError
          // from a bug, ...) stays a defect and re-throws at the edge.
          expected: Error,
          message: "Failed to send notification",
        }),
      ),

    purgeExpiredOrders: ({ olderThanDays }) =>
      fromPromise(
        purgeExpiredOrdersUseCase.execute(olderThanDays),
        qualifyFailure("ORDER_PURGE_FAILED", { expected: Error, message: "Order purge failed" }),
      ).map((purgedCount) => ({ purgedCount })),

    processOrder: {
      // The second (helpers) argument carries `errors` — typed constructors
      // for this activity's contract-declared `errors` map. A declined
      // payment is a *modeled* domain outcome: it becomes
      // `Err(errors.PaymentDeclined({ reason }))`, which crosses the wire as
      // an `ApplicationFailure(type: "PaymentDeclined")` and rehydrates as a
      // typed `ContractError` on the workflow side. Only gateway faults ride
      // the generic `ApplicationFailure` path.
      processPayment: ({ customerId, amount }, { errors }) =>
        fromPromise(
          processPaymentUseCase.execute(customerId, amount),
          qualifyFailure("PAYMENT_GATEWAY_ERROR", {
            expected: Error,
            message: "Payment gateway call failed",
          }),
        ).flatMap((outcome) => {
          if (outcome.status === "declined") {
            return Err(errors.PaymentDeclined({ reason: outcome.reason }));
          }
          return Ok({ transactionId: outcome.transactionId, paidAmount: outcome.paidAmount });
        }),

      reserveInventory: (items) =>
        fromPromise(
          reserveInventoryUseCase.execute(items),
          qualifyFailure("INVENTORY_RESERVATION_FAILED", {
            expected: Error,
            message: "Inventory reservation failed",
          }),
        ),

      releaseInventory: (reservationId) =>
        fromPromise(
          releaseInventoryUseCase.execute(reservationId),
          qualifyFailure("INVENTORY_RELEASE_FAILED", {
            expected: Error,
            message: "Inventory release failed",
          }),
        ),

      createShipment: ({ orderId, customerId }) =>
        fromPromise(
          createShipmentUseCase.execute(orderId, customerId),
          qualifyFailure("SHIPMENT_CREATION_FAILED", {
            expected: Error,
            message: "Shipment creation failed",
          }),
        ),

      refundPayment: (transactionId) =>
        fromPromise(
          refundPaymentUseCase.execute(transactionId),
          qualifyFailure("REFUND_FAILED", { expected: Error, message: "Refund failed" }),
        ),
    },
  },
});
