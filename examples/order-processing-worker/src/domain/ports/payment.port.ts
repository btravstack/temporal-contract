import type { PaymentOutcome } from "../entities/order.schema.js";

/**
 * Payment Port - Interface for payment operations
 */
export type PaymentPort = {
  /**
   * Process a payment for a customer. Resolves with a domain-level outcome:
   * approved (with transaction details) or declined (with a reason).
   * Rejections are reserved for technical gateway faults.
   */
  processPayment(customerId: string, amount: number): Promise<PaymentOutcome>;

  /**
   * Refund a payment transaction
   */
  refundPayment(transactionId: string): Promise<void>;
};
