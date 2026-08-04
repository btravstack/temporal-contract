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
  input: z.object({ customerId: z.string(), amount: z.number() }),
  output: PaymentResultSchema,
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
  // A Completed run charged the customer — Temporal's default
  // (`allow-duplicate`) would let a retried start under the same order ID
  // charge them again. `retry-if-failed` still lets a start be retried after
  // a genuine failure (worker crash, infra blip) without giving up the
  // dedup guarantee that matters: no second successful run per order.
  idempotency: "retry-if-failed",
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
  // Recurring maintenance workflow driven by a Temporal Schedule — every
  // cycle is meant to run again under its schedule-derived ID, which is
  // exactly Temporal's default reuse behavior. Not money-moving, so there's
  // no dedup guarantee to protect here.
  idempotency: "allow-duplicate",
});

// ============================================================================
// Contract Definition
// ============================================================================

export const orderProcessingContract = defineContract({
  taskQueue: "order-processing",
  workflows: { processOrder, cleanupExpiredOrders },
  activities: { sendNotification, purgeExpiredOrders },
});
