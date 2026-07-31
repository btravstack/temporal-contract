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
          testTimeout: 10_000,
          // The per-test fixtures open three Temporal connections and build a
          // workflow bundle per worker before the test body runs. Vitest's
          // 10s hook default was never sized for that — on a loaded CI runner
          // it trips before anything is actually wrong. `testTimeout` above
          // still bounds the test body itself.
          hookTimeout: 60_000,
          setupFiles: ["./src/vitest.setup.ts"],
        },
      },
    ],
  },
});
