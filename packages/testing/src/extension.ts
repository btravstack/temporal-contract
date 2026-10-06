import { Connection } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import { it as vitestIt } from "vitest";

import { getTemporalAddress } from "./internal.js";

export const it = vitestIt.extend<{
  clientConnection: Connection;
  workerConnection: NativeConnection;
}>({
  // oxlint-disable-next-line no-empty-pattern
  clientConnection: async ({}, use) => {
    const connection = await getTemporalConnection();
    await use(connection);
    await connection.close();
  },
  // oxlint-disable-next-line no-empty-pattern
  workerConnection: async ({}, use) => {
    const connection = await getTemporalWorkerConnection();
    await use(connection);
    try {
      await connection.close();
    } catch {
      // NativeConnection.close() races the Rust core's own cleanup when a
      // worker that used this connection has just shut down — the call can
      // reject with an "already closed" style error even though the
      // connection is gone either way. Swallow it so the known shutdown race
      // doesn't fail an otherwise green teardown.
    }
  },
});

/**
 * Get a connection to the Temporal server (for client)
 * Must be called after the testcontainers global setup has been executed
 */
function getTemporalConnection(): Promise<Connection> {
  return Connection.connect({
    address: getTemporalAddress(),
  });
}

/**
 * Get a native connection to the Temporal server (for worker)
 * Must be called after the testcontainers global setup has been executed
 */
function getTemporalWorkerConnection(): Promise<NativeConnection> {
  return NativeConnection.connect({
    address: getTemporalAddress(),
  });
}
