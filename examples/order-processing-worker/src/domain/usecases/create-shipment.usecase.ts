import type { ShippingResult } from "../entities/order.schema.js";
import type { ShippingPort } from "../ports/shipping.port.js";

/**
 * Create Shipment Use Case
 *
 * Business logic for creating shipments
 */
export class CreateShipmentUseCase {
  constructor(private readonly shippingPort: ShippingPort) {}

  async execute(orderId: string, customerId: string): Promise<ShippingResult> {
    // Business validation
    if (!orderId || orderId.trim() === "") {
      // oxlint-disable-next-line unthrown/no-throw -- known-technical precondition throw in a plain (non-Result) domain helper, wrapped once at the activity boundary via fromPromise(..., qualifyFailure(...))
      throw new Error("Order ID is required");
    }

    if (!customerId || customerId.trim() === "") {
      // oxlint-disable-next-line unthrown/no-throw -- known-technical precondition throw in a plain (non-Result) domain helper, wrapped once at the activity boundary via fromPromise(..., qualifyFailure(...))
      throw new Error("Customer ID is required");
    }

    // Delegate to shipping port
    return this.shippingPort.createShipment(orderId, customerId);
  }
}
