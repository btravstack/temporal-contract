import type { PaymentOutcome } from "../entities/order.schema.js";

/**
 * Payment Port - Interface for payment operations
 */
export type PaymentPort = {
  /**
   * Process a payment for a customer. Resolves with a domain-level outcome:
   * approved (with transaction details) or declined (with a reason).
   * Rejections are reserved for technical gateway faults.
   *
   * `idempotencyKey` is the gateway's dedupe key (Stripe's
   * `Idempotency-Key`, and its equivalents): the same key must settle one
   * charge however many times the call is repeated. It comes from the
   * activity's contract declaration, so a retried activity — or a retried
   * workflow — sends the same one.
   */
  processPayment(
    customerId: string,
    amount: number,
    idempotencyKey: string,
  ): Promise<PaymentOutcome>;

  /**
   * Refund a payment transaction, keyed for the same reason as
   * {@link PaymentPort.processPayment}.
   */
  refundPayment(transactionId: string, idempotencyKey: string): Promise<void>;
};
