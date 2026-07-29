/**
 * Order Repository Port - Interface for order persistence operations
 */
export type OrderRepositoryPort = {
  /**
   * Purge orders that finished more than `olderThanDays` days ago.
   * Resolves with the number of purged orders.
   */
  purgeOrdersOlderThan(olderThanDays: number): Promise<number>;
};
