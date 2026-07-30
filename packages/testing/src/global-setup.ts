import { GenericContainer, Wait, Network } from "testcontainers";
import type { TestProject } from "vitest/node";

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
   * PostgreSQL image reference backing the Temporal server.
   *
   * @defaultValue `"postgres:18.1"`
   */
  postgresImage?: string;
  /**
   * Temporal auto-setup image reference — pin this to test against a
   * specific server version.
   *
   * @defaultValue `"temporalio/auto-setup:1.29.1"`
   */
  temporalImage?: string;
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
    postgresImage = "postgres:18.1",
    temporalImage = "temporalio/auto-setup:1.29.1",
    temporalEnv = {},
    quiet = false,
  } = options;

  const log = quiet
    ? () => {}
    : (message: string) => {
        console.log(message);
      };

  return async function setup({ provide }: TestProject) {
    log("🐳 Starting Temporal test environment...");

    // Create a network for containers to communicate
    const network = await new Network().start();

    // Start PostgreSQL container first
    log("🐳 Starting PostgreSQL container...");
    const postgresContainer = await new GenericContainer(postgresImage)
      .withNetwork(network)
      .withNetworkAliases("postgres")
      .withExposedPorts(5432)
      .withEnvironment({
        POSTGRES_DB: "temporal",
        POSTGRES_USER: "temporal",
        POSTGRES_PASSWORD: "temporal",
      })
      .withHealthCheck({
        test: ["CMD-SHELL", "pg_isready -U temporal"],
        interval: 1_000,
        retries: 30,
        startPeriod: 1_000,
        timeout: 1_000,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .start();

    log("✅ PostgreSQL container started");

    // Start Temporal container
    log("🐳 Starting Temporal container...");
    const temporalContainer = await new GenericContainer(temporalImage)
      .withNetwork(network)
      .withExposedPorts(7233)
      .withEnvironment({
        DB: "postgres12",
        DB_PORT: "5432",
        POSTGRES_SEEDS: "postgres",
        POSTGRES_USER: "temporal",
        POSTGRES_PWD: "temporal",
        BIND_ON_IP: "0.0.0.0",
        TEMPORAL_BROADCAST_ADDRESS: "127.0.0.1",
        ...temporalEnv,
      })
      .withHealthCheck({
        test: ["CMD-SHELL", "tctl --address 127.0.0.1:7233 workflow list"],
        interval: 1_000,
        retries: 30,
        startPeriod: 1_000,
        timeout: 1_000,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .start();

    log("✅ Temporal container started");

    const __TESTCONTAINERS_TEMPORAL_IP__ = temporalContainer.getHost();
    const __TESTCONTAINERS_TEMPORAL_PORT_7233__ = temporalContainer.getMappedPort(7233);

    provide("__TESTCONTAINERS_TEMPORAL_IP__", __TESTCONTAINERS_TEMPORAL_IP__);
    provide("__TESTCONTAINERS_TEMPORAL_PORT_7233__", __TESTCONTAINERS_TEMPORAL_PORT_7233__);

    log(
      `🚀 Temporal test environment is ready at ${__TESTCONTAINERS_TEMPORAL_IP__}:${__TESTCONTAINERS_TEMPORAL_PORT_7233__}`,
    );

    // Return teardown function
    return async () => {
      log("🧹 Cleaning up Temporal test environment...");

      try {
        await temporalContainer.stop();
        log("✅ Temporal container stopped");
      } catch (error) {
        console.error("⚠️  Error stopping container:", error);
      }

      try {
        await postgresContainer.stop();
        log("✅ PostgreSQL container stopped");
      } catch (error) {
        console.error("⚠️  Error stopping PostgreSQL container:", error);
      }

      try {
        await network.stop();
        log("✅ Network stopped");
      } catch (error) {
        console.error("⚠️  Error stopping network:", error);
      }
    };
  };
}

/**
 * Default Vitest `globalSetup` — {@link createGlobalSetup} with the stock
 * images and settings. Reference it directly from a vitest config:
 * `globalSetup: "@temporal-contract/testing/global-setup"`.
 */
export default createGlobalSetup();
