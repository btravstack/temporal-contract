/**
 * Coverage for the vitest `globalSetup` hook and its `createGlobalSetup`
 * factory.
 *
 * `testcontainers` is mocked so no Docker daemon is needed: the specs assert
 * the postgres → temporal startup order, that the temporal address is
 * provided to the test project, that teardown stops both containers and
 * the network — swallowing individual stop failures so one broken container
 * doesn't leak the others — and that the factory's options (images, extra
 * temporal env, quiet) are applied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestProject } from "vitest/node";

import setup, { createGlobalSetup } from "./global-setup.js";

type StartedContainer = {
  getHost: () => string;
  getMappedPort: (port: number) => number;
  stop: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => {
  const images: string[] = [];
  const environments: Array<{ image: string; env: Record<string, string> }> = [];
  const startedContainers: Array<{
    getHost: () => string;
    getMappedPort: (port: number) => number;
    stop: ReturnType<typeof vi.fn>;
  }> = [];
  const networkStop = vi.fn(() => Promise.resolve());

  class FakeGenericContainer {
    private readonly image: string;
    constructor(image: string) {
      this.image = image;
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
    withEnvironment(env: Record<string, string>) {
      environments.push({ image: this.image, env });
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

  return {
    images,
    environments,
    startedContainers,
    networkStop,
    FakeGenericContainer,
    FakeNetwork,
  };
});

vi.mock("testcontainers", () => ({
  GenericContainer: mocks.FakeGenericContainer,
  Network: mocks.FakeNetwork,
  Wait: { forHealthCheck: () => ({}) },
}));

function runSetup(
  setupFn: (project: TestProject) => Promise<unknown> = setup,
): Promise<{ provide: ReturnType<typeof vi.fn>; teardown: unknown }> {
  const provide = vi.fn();
  return setupFn({ provide } as unknown as TestProject).then((teardown) => ({
    provide,
    teardown,
  }));
}

describe("global setup", () => {
  beforeEach(() => {
    mocks.images.length = 0;
    mocks.environments.length = 0;
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

describe("createGlobalSetup", () => {
  beforeEach(() => {
    mocks.images.length = 0;
    mocks.environments.length = 0;
    mocks.startedContainers.length = 0;
    mocks.networkStop.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the configured images", async () => {
    await runSetup(
      createGlobalSetup({
        postgresImage: "postgres:16.4",
        temporalImage: "temporalio/auto-setup:1.28.0",
      }),
    );

    expect(mocks.images).toEqual(["postgres:16.4", "temporalio/auto-setup:1.28.0"]);
  });

  it("merges extra env into the temporal container, overriding defaults", async () => {
    await runSetup(
      createGlobalSetup({
        temporalEnv: {
          DYNAMIC_CONFIG_FILE_PATH: "/etc/temporal/dynamic.yaml",
          DB: "postgres13",
        },
      }),
    );

    const temporal = mocks.environments.find(({ image }) => image.startsWith("temporalio/"));
    expect(temporal?.env).toMatchObject({
      DYNAMIC_CONFIG_FILE_PATH: "/etc/temporal/dynamic.yaml",
      // Overrides the built-in default.
      DB: "postgres13",
      // Built-in defaults are preserved.
      POSTGRES_SEEDS: "postgres",
    });

    // The postgres container's env is untouched.
    const postgres = mocks.environments.find(({ image }) => image.startsWith("postgres:"));
    expect(postgres?.env).toEqual({
      POSTGRES_DB: "temporal",
      POSTGRES_USER: "temporal",
      POSTGRES_PASSWORD: "temporal",
    });
  });

  it("silences progress logs with quiet (teardown errors still log)", async () => {
    const { teardown } = await runSetup(createGlobalSetup({ quiet: true }));

    expect(console.log).not.toHaveBeenCalled();

    const [, temporal] = mocks.startedContainers as StartedContainer[];
    temporal?.stop.mockRejectedValueOnce(new Error("already gone"));
    await (teardown as () => Promise<void>)();

    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
