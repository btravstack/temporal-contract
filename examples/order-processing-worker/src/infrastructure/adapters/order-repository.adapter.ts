import type { OrderRepositoryPort } from "../../domain/ports/order-repository.port.js";
import { logger } from "../../logger.js";

/**
 * Mock Order Repository Adapter
 *
 * Concrete implementation of OrderRepositoryPort for testing/demo purposes
 */
export class MockOrderRepositoryAdapter implements OrderRepositoryPort {
  async purgeOrdersOlderThan(olderThanDays: number): Promise<number> {
    // Simulate a database sweep.
    // In a real implementation this would delete expired rows and return the count.
    const purgedCount = Math.floor(Math.random() * 5);

    logger.info(
      { olderThanDays, purgedCount },
      `🧹 Purged ${purgedCount} orders older than ${olderThanDays} days`,
    );

    return purgedCount;
  }
}
