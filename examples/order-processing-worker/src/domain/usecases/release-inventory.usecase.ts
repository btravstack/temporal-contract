import { InventoryError } from "../errors.js";
import type { InventoryPort } from "../ports/inventory.port.js";

/**
 * Release Inventory Use Case
 *
 * Business logic for releasing reserved inventory
 */
export class ReleaseInventoryUseCase {
  constructor(private readonly inventoryPort: InventoryPort) {}

  async execute(reservationId: string): Promise<void> {
    // Business validation
    if (!reservationId || reservationId.trim() === "") {
      // oxlint-disable-next-line unthrown/no-throw -- known-technical precondition throw in a plain (non-Result) domain helper, wrapped once at the activity boundary via fromPromise(..., qualifyFailure(...))
      throw new InventoryError("Reservation ID is required");
    }

    // Delegate to inventory port
    return this.inventoryPort.releaseInventory(reservationId);
  }
}
