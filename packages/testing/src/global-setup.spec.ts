/**
 * Coverage for the vitest `globalSetup` hook.
 *
 * `testcontainers` is mocked so no Docker daemon is needed: the specs assert
 * the postgres → temporal startup order, that the temporal address is
 * provided to the test project, and that teardown stops both containers and
 * the network — swallowing individual stop failures so one broken container
 * doesn't leak the others.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestProject } from "vitest/node";
import setup from "./global-setup.js";

type StartedContainer = {
  getHost: () => string;
  getMappedPort: (port: number) => number;
  stop: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => {
  const images: string[] = [];
  const startedContainers: Array<{
    getHost: () => string;
    getMappedPort: (port: number) => number;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const networkStop = vi.fn(() => Promise.resolve());

  class FakeGenericContainer {
    constructor(image: string) {
      images.push(image);
    }
    withNetwork() {
      return this;
    }
    withNetworkAliases() {
      return this;
    }
    withExposedPorts() {
      return this;
    }
    withEnvironment() {
      return this;
    }
    withHealthCheck() {
      return this;
    }
    withWaitStrategy() {
      return this;
    }
    start() {
      const started = {
        getHost: () => "10.0.0.5",
        getMappedPort: (port: number) => 40_000 + port,
        stop: vi.fn(() => Promise.resolve()),
      };
      startedContainers.push(started);
      return Promise.resolve(started);
    }
  }

  class FakeNetwork {
    start() {
      return Promise.resolve({ stop: networkStop });
    }
  }

  return { images, startedContainers, networkStop, FakeGenericContainer, FakeNetwork };
});

vi.mock("testcontainers", () => ({
  GenericContainer: mocks.FakeGenericContainer,
  Network: mocks.FakeNetwork,
  Wait: { forHealthCheck: () => ({}) },
}));

function runSetup(): Promise<{ provide: ReturnType<typeof vi.fn>; teardown: unknown }> {
  const provide = vi.fn();
  return setup({ provide } as unknown as TestProject).then((teardown) => ({ provide, teardown }));
}

describe("global setup", () => {
  beforeEach(() => {
    mocks.images.length = 0;
    mocks.startedContainers.length = 0;
    mocks.networkStop.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts postgres before temporal and provides the temporal address", async () => {
    const { provide } = await runSetup();

    expect(mocks.images).toHaveLength(2);
    expect(mocks.images[0]).toMatch(/^postgres:/);
    expect(mocks.images[1]).toMatch(/^temporalio\/auto-setup:/);

    expect(provide).toHaveBeenCalledWith("__TESTCONTAINERS_TEMPORAL_IP__", "10.0.0.5");
    expect(provide).toHaveBeenCalledWith("__TESTCONTAINERS_TEMPORAL_PORT_7233__", 47_233);
  });

  it("stops both containers and the network on teardown", async () => {
    const { teardown } = await runSetup();

    await (teardown as () => Promise<void>)();

    expect(mocks.startedContainers).toHaveLength(2);
    for (const container of mocks.startedContainers as StartedContainer[]) {
      expect(container.stop).toHaveBeenCalledTimes(1);
    }
    expect(mocks.networkStop).toHaveBeenCalledTimes(1);
  });

  it("keeps tearing down when a container fails to stop", async () => {
    const { teardown } = await runSetup();

    const [postgres, temporal] = mocks.startedContainers as StartedContainer[];
    temporal?.stop.mockRejectedValueOnce(new Error("already gone"));

    await expect((teardown as () => Promise<void>)()).resolves.toBeUndefined();

    // The postgres container and the network are still cleaned up.
    expect(postgres?.stop).toHaveBeenCalledTimes(1);
    expect(mocks.networkStop).toHaveBeenCalledTimes(1);
  });
});
