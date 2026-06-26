import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      include: ["src/**"],
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
    ],
  },
});
