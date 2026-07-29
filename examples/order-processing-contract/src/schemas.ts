import { z } from "zod";

/**
 * Domain Schemas - Source of truth for business entities
 */

export const OrderItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().positive(),
  price: z.number().positive(),
});

export const OrderSchema = z.object({
  orderId: z.string(),
  customerId: z.string(),
  items: z.array(OrderItemSchema),
  totalAmount: z.number().positive(),
});

/**
 * Successful payment. A declined card is NOT an output shape — it is the
 * `PaymentDeclined` typed contract error declared on the `processPayment`
 * activity (and re-declared on the `processOrder` workflow, which rethrows
 * it so the typed client rehydrates it).
 */
export const PaymentResultSchema = z.object({
  transactionId: z.string(),
  paidAmount: z.number(),
});

/**
 * Data payload of the `PaymentDeclined` typed contract error.
 */
export const PaymentDeclinedDataSchema = z.object({
  reason: z.string(),
});

export const InventoryReservationSchema = z.object({
  reserved: z.boolean(),
  reservationId: z.string().optional(),
});

export const ShippingResultSchema = z.object({
  trackingNumber: z.string(),
  estimatedDelivery: z.string(),
});

/**
 * Payload of the `approveOrder` signal — who approved, with an optional note.
 */
export const OrderApprovalSchema = z.object({
  approvedBy: z.string(),
  note: z.string().optional(),
});

/**
 * Lifecycle of an order inside the `processOrder` workflow, exposed through
 * the `getOrderStatus` query.
 */
export const OrderStatusSchema = z.enum([
  "awaiting_approval",
  "processing_payment",
  "reserving_inventory",
  "creating_shipment",
  "completed",
  "failed",
  "cancelled",
]);

export const OrderStatusReportSchema = z.object({
  status: OrderStatusSchema,
  approvedBy: z.string().optional(),
});

export const OrderResultSchema = z.object({
  orderId: z.string(),
  status: z.enum(["completed", "failed", "cancelled"]),
  transactionId: z.string().optional(),
  trackingNumber: z.string().optional(),
  failureReason: z.string().optional(),
  errorCode: z.string().optional(),
});

/**
 * Input/output of the recurring `cleanupExpiredOrders` workflow, started by
 * a Temporal Schedule (see the client example's `schedule.create` call).
 */
export const CleanupOrdersInputSchema = z.object({
  olderThanDays: z.number().int().positive(),
});

export const CleanupOrdersResultSchema = z.object({
  purgedCount: z.number().int().nonnegative(),
});
