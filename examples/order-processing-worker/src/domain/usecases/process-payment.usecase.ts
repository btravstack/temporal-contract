import type { PaymentOutcome } from "../entities/order.schema.js";
import type { PaymentPort } from "../ports/payment.port.js";

/**
 * Process Payment Use Case
 *
 * Business logic for processing payments
 */
export class ProcessPaymentUseCase {
  constructor(private readonly paymentPort: PaymentPort) {}

  async execute(customerId: string, amount: number): Promise<PaymentOutcome> {
    // Business validation
    if (amount <= 0) {
      // oxlint-disable-next-line unthrown/no-throw -- known-technical precondition throw in a plain (non-Result) domain helper, wrapped once at the activity boundary via fromPromise(..., qualifyFailure(...))
      throw new Error("Payment amount must be positive");
    }

    if (!customerId || customerId.trim() === "") {
      // oxlint-disable-next-line unthrown/no-throw -- known-technical precondition throw in a plain (non-Result) domain helper, wrapped once at the activity boundary via fromPromise(..., qualifyFailure(...))
      throw new Error("Customer ID is required");
    }

    // Delegate to payment port
    return this.paymentPort.processPayment(customerId, amount);
  }
}
