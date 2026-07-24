import type { ShippingResult } from "../../domain/entities/order.schema.js";
import type { ShippingPort } from "../../domain/ports/shipping.port.js";
import { logger } from "../../logger.js";

/**
 * Mock Shipping Adapter
 *
 * Concrete implementation of ShippingPort for testing/demo purposes
 */
export class MockShippingAdapter implements ShippingPort {
  async createShipment(orderId: string, _customerId: string): Promise<ShippingResult> {
    logger.info({ orderId }, `📮 Creating shipment for order ${orderId}`);

    // Simulate shipment creation
    // In real implementation, this would call a shipping provider API
    const trackingNumber = `TRACK${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const estimatedDelivery = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

    const result = {
      trackingNumber,
      estimatedDelivery,
    };

    logger.info({ trackingNumber }, `✅ Shipment created: ${trackingNumber}`);
    return result;
  }
}
