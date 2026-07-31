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
  async processPayment(customerId: string, amount: number): Promise<PaymentOutcome> {
    logger.info(
      { customerId, amount },
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

  async refundPayment(transactionId: string): Promise<void> {
    logger.info({ transactionId }, `💰 Processing refund for transaction ${transactionId}`);

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
