import { randomBytes } from "node:crypto";

import type { TestProject } from "vitest/node";

/**
 * Load `testcontainers` lazily, with a descriptive error when it is not
 * installed. It is an *optional* peer dependency: only this entry point (and
 * therefore `createContractTest`, which requires the global setup to have
 * run) needs it — the Docker-free entries (`/activity`, `/time-skipping`,
 * `/extension`) must stay importable without it.
 */
async function loadTestcontainers(): Promise<typeof import("testcontainers")> {
  try {
    return await import("testcontainers");
  } catch (cause) {
    // oxlint-disable-next-line unthrown/no-throw -- declaration-time fail-fast config error: the global setup cannot run without its optional peer installed
    throw new Error(
      "@temporal-contract/testing/global-setup requires the optional peer dependency " +
        '"testcontainers" (needed by createGlobalSetup / createContractTest). Install it as a ' +
        "dev dependency — e.g. `pnpm add -D testcontainers`. The Docker-free entry points " +
        "(/activity, /time-skipping, /extension) do not need it.",
      { cause },
    );
  }
}

declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- module augmentation requires interface
  export interface ProvidedContext {
    __TESTCONTAINERS_TEMPORAL_IP__: string;
    __TESTCONTAINERS_TEMPORAL_PORT_7233__: number;
  }
}

/**
 * Options for {@link createGlobalSetup}.
 */
export type CreateGlobalSetupOptions = {
  /**
   * PostgreSQL image reference backing the Temporal server. The default is
   * pinned by digest; pass a tag or another digest to override it.
   *
   * @defaultValue `"postgres:18.1@sha256:1090bc3a…"`
   */
  postgresImage?: string;
  /**
   * Temporal auto-setup image reference — pin this to test against a
   * specific server version. The default is pinned by digest.
   *
   * @defaultValue `"temporalio/auto-setup:1.29.1@sha256:5b3502a3…"`
   */
  temporalImage?: string;
  /**
   * How many failed health checks (one per second) each container may go
   * through before startup fails — raise it on slow CI runners or when the
   * images still have to be pulled.
   *
   * @defaultValue `60`
   */
  healthCheckRetries?: number;
  /**
   * Extra environment variables merged into the Temporal container (e.g.
   * dynamic-config knobs). Keys given here override the built-in defaults.
   */
  temporalEnv?: Record<string, string>;
  /**
   * Silence the container-progress `console.log`s. Teardown failures still
   * log via `console.error`.
   *
   * @defaultValue `false`
   */
  quiet?: boolean;
};

/**
 * Build a Vitest `globalSetup` function that starts a Temporal server
 * (PostgreSQL + `temporalio/auto-setup`) via testcontainers before all tests
 * and provides its address to the fixtures in
 * `@temporal-contract/testing/extension` and
 * `@temporal-contract/testing/contract`.
 *
 * The package's default export is `createGlobalSetup()` — reference this
 * factory from your own global-setup module only when you need to pin
 * images, inject extra Temporal env, or silence the progress logs:
 *
 * @example
 * ```ts
 * // temporal-global-setup.ts
 * import { createGlobalSetup } from "@temporal-contract/testing/global-setup";
 *
 * export default createGlobalSetup({
 *   temporalImage: "temporalio/auto-setup:1.28.0",
 *   quiet: true,
 * });
 * ```
 */
export function createGlobalSetup(
  options: CreateGlobalSetupOptions = {},
): (project: TestProject) => Promise<() => Promise<void>> {
  const {
    postgresImage = "postgres:18.1@sha256:1090bc3a8ccfb0b55f78a494d76f8d603434f7e4553543d6e807bc7bd6bbd17f",
    temporalImage = "temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312",
    healthCheckRetries = 60,
    temporalEnv = {},
    quiet = false,
  } = options;

  const log = quiet
    ? () => {}
    : (message: string) => {
        console.log(message);
      };

  return async function setup({ provide }: TestProject) {
    const { GenericContainer, Wait, Network } = await loadTestcontainers();

    log("🐳 Starting Temporal test environment...");

    // Everything started so far, stopped in reverse order — on teardown, and
    // when a later step fails to start, so a failed setup leaks nothing.
    const started: { name: string; stop: () => Promise<unknown> }[] = [];
    const teardown = async () => {
      log("🧹 Cleaning up Temporal test environment...");
      for (const { name, stop } of started.toReversed()) {
        try {
          await stop();
          log(`✅ ${name} stopped`);
        } catch (error) {
          console.error(`⚠️  Error stopping ${name}:`, error);
        }
      }
    };

    // Postgres is only reachable on this network; a fresh password per run
    // keeps it from being a well-known credential.
    const password = randomBytes(16).toString("hex");

    try {
      const network = await new Network().start();
      started.push({ name: "Network", stop: () => network.stop() });

      log("🐳 Starting PostgreSQL container...");
      const postgresContainer = await new GenericContainer(postgresImage)
        .withNetwork(network)
        .withNetworkAliases("postgres")
        .withEnvironment({
          POSTGRES_DB: "temporal",
          POSTGRES_USER: "temporal",
          POSTGRES_PASSWORD: password,
        })
        .withHealthCheck({
          test: ["CMD-SHELL", "pg_isready -U temporal"],
          interval: 1_000,
          retries: healthCheckRetries,
          startPeriod: 1_000,
          timeout: 1_000,
        })
        .withWaitStrategy(Wait.forHealthCheck())
        .start();
      started.push({ name: "PostgreSQL container", stop: () => postgresContainer.stop() });
      log("✅ PostgreSQL container started");

      log("🐳 Starting Temporal container...");
      const temporalContainer = await new GenericContainer(temporalImage)
        .withNetwork(network)
        .withExposedPorts(7233)
        .withEnvironment({
          DB: "postgres12",
          DB_PORT: "5432",
          POSTGRES_SEEDS: "postgres",
          POSTGRES_USER: "temporal",
          POSTGRES_PWD: password,
          BIND_ON_IP: "0.0.0.0",
          TEMPORAL_BROADCAST_ADDRESS: "127.0.0.1",
          ...temporalEnv,
        })
        .withHealthCheck({
          // Lists the `default` namespace's workflows, so the check passes
          // only once auto-setup has registered it.
          test: ["CMD-SHELL", "temporal workflow list --address 127.0.0.1:7233 --limit 1"],
          interval: 1_000,
          retries: healthCheckRetries,
          startPeriod: 1_000,
          timeout: 1_000,
        })
        .withWaitStrategy(Wait.forHealthCheck())
        .start();
      started.push({ name: "Temporal container", stop: () => temporalContainer.stop() });
      log("✅ Temporal container started");

      const __TESTCONTAINERS_TEMPORAL_IP__ = temporalContainer.getHost();
      const __TESTCONTAINERS_TEMPORAL_PORT_7233__ = temporalContainer.getMappedPort(7233);

      provide("__TESTCONTAINERS_TEMPORAL_IP__", __TESTCONTAINERS_TEMPORAL_IP__);
      provide("__TESTCONTAINERS_TEMPORAL_PORT_7233__", __TESTCONTAINERS_TEMPORAL_PORT_7233__);

      log(
        `🚀 Temporal test environment is ready at ${__TESTCONTAINERS_TEMPORAL_IP__}:${__TESTCONTAINERS_TEMPORAL_PORT_7233__}`,
      );
    } catch (error) {
      await teardown();
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned re-raise: the setup failure must keep riding its original error after cleanup
      throw error;
    }

    return teardown;
  };
}

/**
 * Default Vitest `globalSetup` — {@link createGlobalSetup} with the stock
 * images and settings. Reference it directly from a vitest config:
 * `globalSetup: "@temporal-contract/testing/global-setup"`.
 */
export default createGlobalSetup();
