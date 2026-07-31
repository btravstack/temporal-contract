import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      include: ["src/**", "!src/__tests__/**"],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.spec.ts"],
          exclude: ["src/**/__tests__/*.spec.ts"],
          setupFiles: ["./src/vitest.setup.ts"],
        },
      },
      {
        test: {
          name: "integration",
          globalSetup: "@temporal-contract/testing/global-setup",
          include: ["src/**/__tests__/*.spec.ts"],
          exclude: ["src/**/__tests__/*.inprocess.spec.ts"],
          testTimeout: 10_000,
          // Fixture setup opens Temporal connections and builds a workflow
          // bundle per worker before the test body runs; Vitest's 10s hook
          // default is too tight for that on a loaded CI runner. The test
          // body itself is still bounded by `testTimeout` above.
          hookTimeout: 60_000,
          setupFiles: ["./src/vitest.setup.ts"],
        },
      },
      {
        // In-process integration via the time-skipping
        // TestWorkflowEnvironment — no Docker; @temporalio/testing downloads
        // and caches the test-server binary on first run (hence the generous
        // timeout).
        test: {
          name: "integration-inprocess",
          include: ["src/**/__tests__/*.inprocess.spec.ts"],
          testTimeout: 120_000,
          setupFiles: ["./src/vitest.setup.ts"],
        },
      },
    ],
  },
});
