import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default"],
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      include: ["src/**"],
    },
    // The unit specs exercise `extension.ts` with mocked Temporal
    // connections, so the address normally provided by the testcontainers
    // global setup is stubbed statically here.
    provide: {
      __TESTCONTAINERS_TEMPORAL_IP__: "127.0.0.1",
      __TESTCONTAINERS_TEMPORAL_PORT_7233__: 7233,
    },
  },
});
