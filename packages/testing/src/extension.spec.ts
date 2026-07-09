/**
 * Coverage for the `it` fixture extension.
 *
 * The Temporal connections are mocked so the fixtures can run without a
 * server; the injected testcontainers address is provided statically via
 * `test.provide` in `vitest.config.ts`. The specs assert that both fixtures
 * connect to the injected address, and that the client connection is closed
 * after the test that used it completes (while the worker connection's
 * cleanup is deliberately left to the test framework).
 */
import { describe, expect, vi } from "vitest";
import { it } from "./extension.js";

const mocks = vi.hoisted(() => {
  const clientClose = vi.fn(() => Promise.resolve());
  return {
    clientClose,
    clientConnect: vi.fn(() => Promise.resolve({ close: clientClose })),
    workerConnect: vi.fn(() => Promise.resolve({ kind: "native-connection" })),
  };
});

vi.mock("@temporalio/client", () => ({
  Connection: { connect: mocks.clientConnect },
}));

vi.mock("@temporalio/worker", () => ({
  NativeConnection: { connect: mocks.workerConnect },
}));

describe("it.clientConnection", () => {
  it("connects a client to the injected testcontainers address", ({ clientConnection }) => {
    expect(mocks.clientConnect).toHaveBeenCalledExactlyOnceWith({ address: "127.0.0.1:7233" });
    expect(clientConnection).toEqual({ close: mocks.clientClose });
    // Still open while the test runs.
    expect(mocks.clientClose).not.toHaveBeenCalled();
  });

  it("closes the client connection after the test that used it completes", () => {
    // The previous test's fixture has been torn down by the time this runs.
    expect(mocks.clientClose).toHaveBeenCalledTimes(1);
  });
});

describe("it.workerConnection", () => {
  it("connects a native connection to the injected testcontainers address", ({
    workerConnection,
  }) => {
    expect(mocks.workerConnect).toHaveBeenCalledExactlyOnceWith({ address: "127.0.0.1:7233" });
    expect(workerConnection).toEqual({ kind: "native-connection" });
  });
});
