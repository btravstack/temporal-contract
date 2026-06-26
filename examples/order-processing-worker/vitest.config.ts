import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "@temporal-contract/testing/global-setup",
    reporters: ["default"],
    setupFiles: ["./src/vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      include: ["src/**"],
    },
  },
});
