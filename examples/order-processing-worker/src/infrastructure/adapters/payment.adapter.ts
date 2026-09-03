import type { PaymentOutcome } from "../../domain/entities/order.schema.js";
import { PaymentError } from "../../domain/errors.js";
import type { PaymentPort } from "../../domain/ports/payment.port.js";
import { logger } from "../../logger.js";

/**
 * Mock Payment Adapter
 *
 * Concrete implementation of PaymentPort for testing/demo purposes
 */
export class MockPaymentAdapter implements PaymentPort {
  /**
   * Charges already settled, by idempotency key. A real gateway keeps this
   * ledger on its side; the mock keeps it here so the example actually
   * demonstrates the guarantee instead of just passing the key around.
   */
  private readonly settled = new Map<string, PaymentOutcome>();

  async processPayment(
    customerId: string,
    amount: number,
    idempotencyKey: string,
  ): Promise<PaymentOutcome> {
    const alreadySettled = this.settled.get(idempotencyKey);
    if (alreadySettled) {
      // This is the at-least-once case: the activity ran before (a retry, a
      // worker crash, a completion Temporal never recorded) — or the whole
      // workflow was restarted under the same order. Same key, same answer,
      // one charge.
      logger.info({ idempotencyKey }, `↩️  Replayed settled charge for ${idempotencyKey}`);
      return alreadySettled;
    }

    logger.info(
      { customerId, amount, idempotencyKey },
      `💳 Processing payment of $${amount} for customer ${customerId}`,
    );

    // Simulate payment processing
    // In real implementation, this would call a payment gateway API
    const approved = Math.random() > 0.1; // 10% decline rate

    if (approved) {
      const result: PaymentOutcome = {
        status: "approved" as const,
        transactionId: `TXN${Date.now()}`,
        paidAmount: amount,
      };

      logger.info(
        { transactionId: result.transactionId },
        `✅ Payment processed: ${result.transactionId}`,
      );

      // Only an approval is recorded: a decline settled nothing, so a later
      // attempt with the same key is free to be approved.
      this.settled.set(idempotencyKey, result);

      return result;
    } else {
      // A decline is a modeled business outcome, not an exception — the
      // activity boundary converts it into the `PaymentDeclined` contract
      // error.
      const result: PaymentOutcome = {
        status: "declined" as const,
        reason: "insufficient_funds",
      };

      logger.warn(`❌ Payment declined: ${result.reason}`);

      return result;
    }
  }

  async refundPayment(transactionId: string, idempotencyKey: string): Promise<void> {
    logger.info(
      { transactionId, idempotencyKey },
      `💰 Processing refund for transaction ${transactionId}`,
    );

    // Simulate refund processing with 99% success rate
    const success = Math.random() > 0.01;

    if (success) {
      logger.info(`✅ Refund successful`);
    } else {
      logger.error(`❌ Refund failed`);
      // oxlint-disable-next-line unthrown/no-throw -- known-technical precondition throw in a plain (non-Result) domain helper, wrapped once at the activity boundary via fromPromise(..., qualifyFailure(...))
      throw new PaymentError("Payment processor rejected refund request");
    }
  }
}
