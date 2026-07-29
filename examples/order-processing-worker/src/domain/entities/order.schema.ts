/**
 * Domain Entity Types - Inferred from contract package schemas
 *
 * These types are inferred locally for use within the worker implementation.
 * The schemas themselves are defined in the contract package.
 */

import {
  type OrderItemSchema,
  type PaymentResultSchema,
  type InventoryReservationSchema,
  type ShippingResultSchema,
} from "@temporal-contract/sample-order-processing-contract";
import type { z } from "zod";

export type OrderItem = z.infer<typeof OrderItemSchema>;
export type PaymentResult = z.infer<typeof PaymentResultSchema>;
export type InventoryReservation = z.infer<typeof InventoryReservationSchema>;
export type ShippingResult = z.infer<typeof ShippingResultSchema>;

/**
 * Domain-level payment outcome. A decline is a *modeled* business outcome of
 * the payment gateway — the activity boundary maps it onto the contract's
 * `PaymentDeclined` typed error (see application/activities.ts), so it never
 * travels as an untyped exception.
 */
export type PaymentOutcome =
  | ({ status: "approved" } & PaymentResult)
  | { status: "declined"; reason: string };
