import { defineContract } from "@temporal-contract/contract";
import { z } from "zod";
import {
  OrderSchema,
  OrderItemSchema,
  PaymentResultSchema,
  InventoryReservationSchema,
  ShippingResultSchema,
  OrderResultSchema,
} from "./schemas.js";

/**
 * Order Processing Contract
 *
 * This contract defines a unified order processing system with:
 * - Global activities for logging and notifications
 * - A workflow for processing orders with payment, inventory, and shipping
 * - Support for both standard Promise-based and Result/Future pattern implementations
 *
 * The contract uses domain schemas as the source of truth for business entities.
 */

// ============================================================================
// Contract Definition
// ============================================================================

export const orderProcessingContract = defineContract({
  taskQueue: "order-processing",

  /**
   * Global activities available to all workflows
   */
  activities: {
    /**
     * Send a notification to a customer
     */
    sendNotification: {
      input: z.object({ customerId: z.string(), subject: z.string(), message: z.string() }),
      output: z.void(),
    },
  },

  /**
   * Workflows in this contract
   */
  workflows: {
    /**
     * Process an order from payment to shipping
     */
    processOrder: {
      input: OrderSchema,
      output: OrderResultSchema,

      /**
       * Activities specific to the processOrder workflow
       */
      activities: {
        /**
         * Process payment for the order
         */
        processPayment: {
          input: z.object({ customerId: z.string(), amount: z.number() }),
          output: PaymentResultSchema,
        },

        /**
         * Reserve inventory for the order items
         */
        reserveInventory: {
          input: z.array(OrderItemSchema),
          output: InventoryReservationSchema,
        },

        /**
         * Release reserved inventory
         */
        releaseInventory: {
          input: z.string(),
          output: z.void(),
        },

        /**
         * Create a shipment for the order
         */
        createShipment: {
          input: z.object({ orderId: z.string(), customerId: z.string() }),
          output: ShippingResultSchema,
        },

        /**
         * Refund a payment (used in case of errors)
         */
        refundPayment: {
          input: z.string(),
          output: z.void(),
        },
      },
    },
  },
});
