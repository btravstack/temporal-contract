import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const pkg = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Workspace-only plumbing — a real consumer needs none of this.
//
// `@temporal-contract/testing`'s built `contract.mjs` imports `TypedClient`
// from `@temporal-contract/client` and `TypedWorker` from
// `@temporal-contract/worker/worker`, both `peerDependencies` of `testing`
// rather than dependencies. For someone who installed from npm those resolve
// fine: their own `node_modules` sits above the dist file. Inside this
// workspace pnpm symlinks `@temporal-contract/testing` straight to
// `packages/testing`, and Node resolves bare specifiers from that real path,
// which has no route to `client`/`worker`.
//
// So: alias the two specifiers to source, and `server.deps.inline` the
// prebuilt `testing` package so Vitest routes it through Vite's resolver
// (which is what makes the alias apply) instead of externalizing it to
// Node's loader. Same technique, same reason, as
// `packages/worker/vitest.config.ts`.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@temporal-contract\/client$/,
        replacement: pkg("../../packages/client/src/index.ts"),
      },
      {
        find: /^@temporal-contract\/worker\/worker$/,
        replacement: pkg("../../packages/worker/src/worker.ts"),
      },
    ],
  },
  test: {
    server: { deps: { inline: [/@temporal-contract\/testing/] } },
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
