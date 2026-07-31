import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "@temporal-contract/testing/global-setup",
    reporters: ["default"],
    setupFiles: ["./src/vitest.setup.ts"],
    // These specs drive a real Temporal server through testcontainers, and
    // fixture setup builds a workflow bundle per worker. Vitest's 5s test /
    // 10s hook defaults are sized for unit tests, not for that.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      include: ["src/**"],
    },
  },
});
