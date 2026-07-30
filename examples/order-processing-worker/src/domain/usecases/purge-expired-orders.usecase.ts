import type { OrderRepositoryPort } from "../ports/order-repository.port.js";

/**
 * Purge Expired Orders Use Case
 *
 * Business logic for the recurring order cleanup (schedule-driven).
 */
export class PurgeExpiredOrdersUseCase {
  constructor(private readonly orderRepository: OrderRepositoryPort) {}

  async execute(olderThanDays: number): Promise<number> {
    // Business validation
    if (!Number.isInteger(olderThanDays) || olderThanDays <= 0) {
      // oxlint-disable-next-line unthrown/no-throw -- known-technical precondition throw in a plain (non-Result) domain helper, wrapped once at the activity boundary via fromPromise(..., qualifyFailure(...))
      throw new Error("olderThanDays must be a positive integer");
    }

    // Delegate to order repository port
    return this.orderRepository.purgeOrdersOlderThan(olderThanDays);
  }
}
