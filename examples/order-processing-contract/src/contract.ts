import {
  defineActivity,
  defineContract,
  defineQuery,
  defineSignal,
  defineWorkflow,
  type ErrorDefinition,
} from "@temporal-contract/contract";
import { z } from "zod";

import {
  CleanupOrdersInputSchema,
  CleanupOrdersResultSchema,
  InventoryReservationSchema,
  OrderApprovalSchema,
  OrderItemSchema,
  OrderResultSchema,
  OrderSchema,
  OrderStatusReportSchema,
  PaymentDeclinedDataSchema,
  PaymentResultSchema,
  ShippingResultSchema,
} from "./schemas.js";

/**
 * Order Processing Contract
 *
 * A unified order processing system demonstrating the full contract surface:
 * - Global activities shared across workflows (`sendNotification`,
 *   `purgeExpiredOrders`)
 * - The `processOrder` workflow with workflow-local activities, signals
 *   (payload-carrying and payload-less), an argument-less query, and a typed
 *   contract error
 * - The activity-less `cleanupExpiredOrders` workflow, designed to run on a
 *   Temporal Schedule
 *
 * Composition-first: every resource is defined with its `define*` helper and
 * referenced here, keeping the contract a readable table of contents.
 */

// ============================================================================
// Typed contract errors
// ============================================================================

/**
 * Declared on the `processPayment` activity (produced via the activity
 * implementation's `errors` helpers) AND on the `processOrder` workflow
 * (rethrown via `context.errors`), so a decline travels typed end-to-end:
 * activity → workflow → client. On the wire it is an `ApplicationFailure`
 * with `type: "PaymentDeclined"` and `details[0]` validated against `data`;
 * consumers rehydrate it into a `ContractError`.
 */
const paymentDeclinedError = {
  data: PaymentDeclinedDataSchema,
  message: "Payment was declined by the payment provider",
  nonRetryable: true,
} satisfies ErrorDefinition;

// ============================================================================
// Global activities (shared by all workflows)
// ============================================================================

/**
 * Send a notification to a customer.
 */
const sendNotification = defineActivity({
  input: z.object({ customerId: z.string(), subject: z.string(), message: z.string() }),
  output: z.void(),
});

/**
 * Purge orders that finished more than `olderThanDays` days ago. Used by the
 * schedule-driven `cleanupExpiredOrders` workflow.
 */
const purgeExpiredOrders = defineActivity({
  input: CleanupOrdersInputSchema,
  output: CleanupOrdersResultSchema,
});

// ============================================================================
// processOrder — workflow-local activities
// ============================================================================

/**
 * Process payment for the order. Declares the `PaymentDeclined` typed error:
 * the implementation surfaces a decline as
 * `Err(errors.PaymentDeclined({ reason }))`, which the workflow receives as
 * a typed `ContractError` on the activity call's error channel.
 */
const processPayment = defineActivity({
  // `orderId` is here for the idempotency key rather than for the charge
  // itself: the key has to name the *business operation*, and a customer may
  // legitimately place two orders for the same amount.
  input: z.object({ orderId: z.string(), customerId: z.string(), amount: z.number() }),
  output: PaymentResultSchema,
  // Temporal runs an activity AT LEAST once — a retry, a worker crash, or a
  // completion that succeeded but was never recorded all re-run this. The
  // key travels to the gateway so the second run settles the first charge
  // instead of making a new one. Keying on customer + amount would collide
  // across two distinct orders and swallow the second charge entirely.
  idempotencyKey: ({ orderId }) => `charge:${orderId}`,
  errors: {
    PaymentDeclined: paymentDeclinedError,
  },
});

/**
 * Reserve inventory for the order items.
 */
const reserveInventory = defineActivity({
  input: z.array(OrderItemSchema),
  output: InventoryReservationSchema,
});

/**
 * Release reserved inventory.
 */
const releaseInventory = defineActivity({
  input: z.string(),
  output: z.void(),
});

/**
 * Create a shipment for the order.
 */
const createShipment = defineActivity({
  input: z.object({ orderId: z.string(), customerId: z.string() }),
  output: ShippingResultSchema,
});

/**
 * Refund a payment (used in case of errors).
 */
const refundPayment = defineActivity({
  input: z.string(),
  output: z.void(),
  // Same reasoning as `processPayment`, opposite direction — and a distinct
  // prefix, because a gateway keyed on the transaction alone would treat the
  // charge and its refund as the same request.
  idempotencyKey: (transactionId) => `refund:${transactionId}`,
});

// ============================================================================
// processOrder — signals and queries
// ============================================================================

/**
 * Approve a high-value order, carrying who approved and an optional note.
 */
const approveOrder = defineSignal({ input: OrderApprovalSchema });

/**
 * Request cancellation of the order. Payload-less — `defineSignal()` without
 * an input schema: the handler input is `undefined` and clients send it with
 * no arguments.
 */
const cancelRequested = defineSignal();

/**
 * Read the order's current lifecycle status. Argument-less —
 * `defineQuery({ output })` without an input schema.
 */
const getOrderStatus = defineQuery({ output: OrderStatusReportSchema });

// ============================================================================
// Workflows
// ============================================================================

/**
 * Process an order from approval to shipping.
 *
 * Orders above the worker's approval threshold wait for the `approveOrder`
 * signal (or `cancelRequested`) before payment. A declined payment fails the
 * execution with the typed `PaymentDeclined` contract error.
 */
const processOrder = defineWorkflow({
  input: OrderSchema,
  output: OrderResultSchema,
  // The ID is derived from the order, not supplied by the caller: a client
  // passing a fresh UUID per attempt would make any start policy inert,
  // because every retry would be a different workflow ID.
  workflowId: ({ orderId }) => `order-${orderId}`,
  // A Completed run charged the customer, so a second successful run under
  // the same order must not happen. `retry-if-failed` still allows a start
  // after a run that ended Failed — chiefly `PaymentDeclined`, where no
  // charge went through, so the customer can retry without a new order ID.
  //
  // Post-charge terminal failures (a failed compensating `refundPayment`, a
  // cancel during inventory reservation, a `createShipment` failure) also end
  // the run in a state this policy treats as re-runnable. What stops those
  // from double-charging is not this field but `processPayment`'s
  // `idempotencyKey`: a retried start derives the same key from the same
  // customer and amount, so the gateway settles one charge no matter how
  // many times the activity runs. Start policy dedupes *executions*; the
  // activity key dedupes *effects*, and Temporal's at-least-once activity
  // guarantee means only the second one can close this gap.
  startPolicy: "retry-if-failed",
  activities: {
    processPayment,
    reserveInventory,
    releaseInventory,
    createShipment,
    refundPayment,
  },
  signals: {
    approveOrder,
    cancelRequested,
  },
  queries: {
    getOrderStatus,
  },
  errors: {
    PaymentDeclined: paymentDeclinedError,
  },
});

/**
 * Recurring order cleanup, designed to be started by a Temporal Schedule
 * (see the client example's `schedule.create` call). It declares NO
 * workflow-local activities — it only uses the global `purgeExpiredOrders` —
 * so the worker's activities implementation map needs no entry for it.
 */
const cleanupExpiredOrders = defineWorkflow({
  input: CleanupOrdersInputSchema,
  output: CleanupOrdersResultSchema,
  // Recurring maintenance workflow driven by a Temporal Schedule. This
  // declaration is inert here regardless of which mode is picked:
  // `schedule.create`'s action type has no `workflowIdReusePolicy` field, so
  // every scheduled run gets Temporal's own default (`ALLOW_DUPLICATE`) no
  // matter what `startPolicy` says (see "Schedule workflows" in the docs).
  // `allow-duplicate` is chosen anyway to document the intent for any path
  // that *does* apply it — a direct `client.startWorkflow` under this
  // workflow's type, for instance — and because purging expired orders
  // twice is harmless.
  startPolicy: "allow-duplicate",
});

// ============================================================================
// Contract Definition
// ============================================================================

export const orderProcessingContract = defineContract({
  taskQueue: "order-processing",
  workflows: { processOrder, cleanupExpiredOrders },
  activities: { sendNotification, purgeExpiredOrders },
});
