import type { PaymentPort } from "../ports/payment.port.js";

/**
 * Refund Payment Use Case
 *
 * Business logic for refunding payments
 */
export class RefundPaymentUseCase {
  constructor(private readonly paymentPort: PaymentPort) {}

  async execute(transactionId: string): Promise<void> {
    // Business validation
    if (!transactionId || transactionId.trim() === "") {
      // oxlint-disable-next-line unthrown/no-throw -- known-technical precondition throw in a plain (non-Result) domain helper, wrapped once at the activity boundary via fromPromise(..., qualifyFailure(...))
      throw new Error("Transaction ID is required");
    }

    // Delegate to payment port
    return this.paymentPort.refundPayment(transactionId);
  }
}
