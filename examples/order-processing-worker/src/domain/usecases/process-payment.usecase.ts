import type { PaymentOutcome } from "../entities/order.schema.js";
import { PaymentError } from "../errors.js";
import type { PaymentPort } from "../ports/payment.port.js";

/**
 * Process Payment Use Case
 *
 * Business logic for processing payments
 */
export class ProcessPaymentUseCase {
  constructor(private readonly paymentPort: PaymentPort) {}

  async execute(
    customerId: string,
    amount: number,
    idempotencyKey: string,
  ): Promise<PaymentOutcome> {
    // Business validation
    if (amount <= 0) {
      // oxlint-disable-next-line unthrown/no-throw -- known-technical precondition throw in a plain (non-Result) domain helper, wrapped once at the activity boundary via fromPromise(..., qualifyFailure(...))
      throw new PaymentError("Payment amount must be positive");
    }

    if (!customerId || customerId.trim() === "") {
      // oxlint-disable-next-line unthrown/no-throw -- known-technical precondition throw in a plain (non-Result) domain helper, wrapped once at the activity boundary via fromPromise(..., qualifyFailure(...))
      throw new PaymentError("Customer ID is required");
    }

    // Delegate to payment port
    return this.paymentPort.processPayment(customerId, amount, idempotencyKey);
  }
}
