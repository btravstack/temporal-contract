import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const sibling = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// `@temporal-contract/testing`'s built `test-rig.mjs` imports these two
// specifiers at the top level (`TypedClient`, `TypedWorker`). They're
// `peerDependencies` of `testing`, not `devDependencies` — a devDependency
// would create a real cycle (`client`/`worker` already devDepend on
// `testing`), which would break turbo's package-graph ordering. Peer specs
// resolve fine for a real published consumer (whose own node_modules sits
// above the dist file), but inside this workspace pnpm symlinks
// `@temporal-contract/testing` straight to `packages/testing` and Node
// resolves bare specifiers from that real path, which has no route to
// `client`/`worker` in its own `node_modules`. Aliasing to source here
// mirrors the same technique `packages/testing/vitest.config.ts` already
// uses to resolve *its* peers for its own test run.
const workspaceAliases = [
  { find: /^@temporal-contract\/client$/, replacement: sibling("../client/src/index.ts") },
  { find: /^@temporal-contract\/worker\/worker$/, replacement: sibling("./src/worker.ts") },
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
        test: {
          name: "unit",
          include: ["src/**/*.spec.ts"],
          exclude: ["src/**/__tests__/*.spec.ts"],
          setupFiles: ["./src/vitest.setup.ts"],
        },
      },
      {
        resolve: { alias: workspaceAliases },
        test: {
          name: "integration",
          server: { deps: { inline: [/@temporal-contract\/testing/] } },
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
        resolve: { alias: workspaceAliases },
        // In-process integration via the time-skipping
        // TestWorkflowEnvironment — no Docker; @temporalio/testing downloads
        // and caches the test-server binary on first run (hence the generous
        // timeout).
        test: {
          name: "integration-inprocess",
          server: { deps: { inline: [/@temporal-contract\/testing/] } },
          include: ["src/**/__tests__/*.inprocess.spec.ts"],
          testTimeout: 120_000,
          setupFiles: ["./src/vitest.setup.ts"],
        },
      },
    ],
  },
});
