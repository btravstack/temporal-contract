import { Connection } from "@temporalio/client";
import { NativeConnection } from "@temporalio/worker";
import { inject, it as vitestIt } from "vitest";

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

/**
 * Join the host/port pair injected by the testcontainers global setup into a
 * Temporal address, failing with a descriptive error when the global setup
 * was never registered (in which case `inject` yields `undefined` and the
 * fixtures would otherwise try to connect to `"undefined:undefined"`).
 *
 * @internal — exported for unit tests only.
 */
export function resolveTemporalAddress(host: string | undefined, port: number | undefined): string {
  if (host === undefined || port === undefined) {
    // oxlint-disable-next-line unthrown/no-throw -- declaration-time fail-fast config error: missing global-setup injection must abort the test run with a descriptive message
    throw new Error(
      "Temporal test-server address was not injected into this test project. " +
        'Register the testcontainers global setup in your vitest config — globalSetup: "@temporal-contract/testing/global-setup" ' +
        "(or a module default-exporting createGlobalSetup(...)) — so the fixtures from @temporal-contract/testing know where to connect.",
    );
  }
  return `${host}:${port}`;
}

function getTemporalAddress(): string {
  // The ProvidedContext augmentation types these keys as always present, but
  // at runtime they are only there when the global setup actually ran.
  return resolveTemporalAddress(
    inject("__TESTCONTAINERS_TEMPORAL_IP__") as string | undefined,
    inject("__TESTCONTAINERS_TEMPORAL_PORT_7233__") as number | undefined,
  );
}
