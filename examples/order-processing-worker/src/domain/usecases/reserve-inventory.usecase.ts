import type { InventoryReservation, OrderItem } from "../entities/order.schema.js";
import type { InventoryPort } from "../ports/inventory.port.js";

/**
 * Reserve Inventory Use Case
 *
 * Business logic for reserving inventory
 */
export class ReserveInventoryUseCase {
  constructor(private readonly inventoryPort: InventoryPort) {}

  async execute(items: OrderItem[]): Promise<InventoryReservation> {
    // Business validation
    if (!items || items.length === 0) {
      throw new Error("At least one item is required");
    }

    for (const item of items) {
      if (item.quantity <= 0) {
        throw new Error(`Invalid quantity for product ${item.productId}`);
      }
    }

    // Delegate to inventory port
    return this.inventoryPort.reserveInventory(items);
  }
}
