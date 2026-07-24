import type { PaymentResult } from "../entities/order.schema.js";
import type { PaymentPort } from "../ports/payment.port.js";

/**
 * Process Payment Use Case
 *
 * Business logic for processing payments
 */
export class ProcessPaymentUseCase {
  constructor(private readonly paymentPort: PaymentPort) {}

  async execute(customerId: string, amount: number): Promise<PaymentResult> {
    // Business validation
    if (amount <= 0) {
      throw new Error("Payment amount must be positive");
    }

    if (!customerId || customerId.trim() === "") {
      throw new Error("Customer ID is required");
    }

    // Delegate to payment port
    return this.paymentPort.processPayment(customerId, amount);
  }
}
