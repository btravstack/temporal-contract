import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The sibling packages are peers (a dev/regular dep would create a package
// cycle — client/worker devDepend on this package), so their specifiers are
// aliased to source for the test runtime, mirroring tsconfig.json's `paths`.
const sibling = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const workspaceAliases = [
  { find: /^@temporal-contract\/client$/, replacement: sibling("../client/src/index.ts") },
  { find: /^@temporal-contract\/contract$/, replacement: sibling("../contract/src/index.ts") },
  {
    find: /^@temporal-contract\/contract\/errors$/,
    replacement: sibling("../contract/src/errors.ts"),
  },
  {
    find: /^@temporal-contract\/contract\/internal$/,
    replacement: sibling("../contract/src/internal.ts"),
  },
  {
    find: /^@temporal-contract\/worker\/activity$/,
    replacement: sibling("../worker/src/activity.ts"),
  },
  { find: /^@temporal-contract\/worker\/worker$/, replacement: sibling("../worker/src/worker.ts") },
  {
    find: /^@temporal-contract\/worker\/workflow$/,
    replacement: sibling("../worker/src/workflow.ts"),
  },
];

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
        resolve: { alias: workspaceAliases },
        test: {
          name: "unit",
          include: ["src/**/*.spec.ts"],
          exclude: ["src/**/__tests__/*.spec.ts"],
          setupFiles: ["./src/vitest.setup.ts"],
          // The unit specs exercise `extension.ts` with mocked Temporal
          // connections, so the address normally provided by the
          // testcontainers global setup is stubbed statically here.
          provide: {
            __TESTCONTAINERS_TEMPORAL_IP__: "127.0.0.1",
            __TESTCONTAINERS_TEMPORAL_PORT_7233__: 7233,
          },
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: "integration",
          globalSetup: "./src/global-setup.ts",
          include: ["src/**/__tests__/*.spec.ts"],
          setupFiles: ["./src/vitest.setup.ts"],
          testTimeout: 30_000,
          // Fixture setup opens Temporal connections and builds a workflow
          // bundle before the test body runs; Vitest's 10s hook default is
          // too tight for that on a loaded CI runner.
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
