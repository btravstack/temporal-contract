/**
 * Coverage for the `it` fixture extension.
 *
 * The Temporal connections are mocked so the fixtures can run without a
 * server; the injected testcontainers address is provided statically via
 * `test.provide` in `vitest.config.ts`. The specs assert that both fixtures
 * connect to the injected address, that both connections are closed after
 * the test that used them completes (the worker connection's close swallows
 * the known shutdown race), and that a missing injected address fails with a
 * descriptive error naming the global setup.
 */
import { afterAll, describe, expect, vi } from "vitest";

import { it, resolveTemporalAddress } from "./extension.js";

const mocks = vi.hoisted(() => {
  const clientClose = vi.fn(() => Promise.resolve());
  const workerClose = vi.fn(() => Promise.resolve());
  return {
    clientClose,
    workerClose,
    clientConnect: vi.fn(() => Promise.resolve({ close: clientClose })),
    workerConnect: vi.fn(() => Promise.resolve({ close: workerClose })),
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

  // `afterAll` runs after every test in this block has finished, including
  // the fixture teardown of the test above — so this asserts the fixture
  // closed the connection without depending on test execution order.
  afterAll(() => {
    expect(mocks.clientClose).toHaveBeenCalledTimes(1);
  });
});

describe("it.workerConnection", () => {
  it("connects a native connection to the injected testcontainers address", ({
    workerConnection,
  }) => {
    expect(mocks.workerConnect).toHaveBeenCalledExactlyOnceWith({ address: "127.0.0.1:7233" });
    expect(workerConnection).toEqual({ close: mocks.workerClose });
    // Still open while the test runs.
    expect(mocks.workerClose).not.toHaveBeenCalled();
  });

  it("swallows the known close race during teardown", ({ workerConnection }) => {
    // The next fixture teardown rejects — the fixture must not fail the run.
    mocks.workerClose.mockRejectedValueOnce(new Error("already closed") as never);
    expect(workerConnection).toBeDefined();
  });

  // Both tests above used the fixture, so close was attempted twice — once
  // resolving, once rejecting (and swallowed).
  afterAll(() => {
    expect(mocks.workerClose).toHaveBeenCalledTimes(2);
  });
});

describe("resolveTemporalAddress", () => {
  it("joins the injected host and port", () => {
    expect(resolveTemporalAddress("10.0.0.5", 47_233)).toBe("10.0.0.5:47233");
  });

  it("fails with an error naming the global setup when the host is missing", () => {
    expect(() => resolveTemporalAddress(undefined, 7233)).toThrowError(
      /@temporal-contract\/testing\/global-setup/,
    );
  });

  it("fails with an error naming the global setup when the port is missing", () => {
    expect(() => resolveTemporalAddress("127.0.0.1", undefined)).toThrowError(
      /@temporal-contract\/testing\/global-setup/,
    );
  });
});
