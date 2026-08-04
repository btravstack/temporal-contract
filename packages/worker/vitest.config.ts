import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const sibling = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// `@temporal-contract/testing`'s built `test-rig.mjs` imports `TypedClient`
// from `@temporal-contract/client` and `TypedWorker` from
// `@temporal-contract/worker/worker` at the top level. Both are
// `peerDependencies` of `testing`, not `devDependencies` — a devDependency
// would create a real cycle (`client` already devDepends on `testing`),
// which would break turbo's package-graph ordering. Peer specs resolve fine
// for a real published consumer (whose own node_modules sits above the dist
// file), but inside this workspace pnpm symlinks `@temporal-contract/testing`
// straight to `packages/testing`, and Node resolves bare specifiers from
// that real path — which has no route to `client`/`worker` in its own
// `node_modules`. Tried `dependenciesMeta.injected: true` on `testing` in
// this package's `package.json` first (hard-links `testing` into this
// package's `node_modules` instead), but it made `pnpm install` fail:
// resolving `testing`'s peer on `@temporal-contract/worker` (this very
// package, which — being a peer, not a workspace dependency — doesn't
// self-reference) fell through to the registry and tripped
// `minimumReleaseAge`'s supply-chain-maturity gate
// (`[ERR_PNPM_NO_MATURE_MATCHING_VERSION]`, naming
// `@temporal-contract/contract@8.0.0-beta.4` and
// `@temporal-contract/worker@8.0.0-beta.4`). Aliasing to source here instead
// mirrors the *resolve.alias* half of the technique
// `packages/testing/vitest.config.ts` already uses to resolve its own
// peers — `server.deps.inline` below has no counterpart there: testing's
// config aliases bare specifiers imported from its own *source* .ts files,
// which Vite/esbuild transforms and resolves natively, alias included. Here
// the entry point is a prebuilt `.mjs` under `@temporal-contract/testing`,
// which Vitest externalizes to Node's native loader by default — bypassing
// Vite's resolver, and therefore this alias, entirely. `server.deps.inline`
// forces Vitest to route that package through Vite instead, which is the
// only reason it's needed here.
//
// Deliberately scoped to the `integration-inprocess` project only (not
// `integration`, the Docker tier) — nothing in that tier consumes `testRig`
// yet, and applying it there would silently swap 10 unrelated spec files
// from exercising `@temporal-contract/client`'s built `dist` output to its
// source, retiring the only place that dist ever runs under test. If a
// future migration needs `testRig` from the Docker tier too, widen this
// deliberately, not as a side effect of some other change.
//
// Only the two specifiers `test-rig.ts` actually imports today are aliased.
// `packages/testing/vitest.config.ts` also aliases `@temporal-contract/contract`,
// `/contract/errors`, `/contract/internal`, `/worker/activity`, and
// `/worker/workflow` for its own broader needs — add the matching entry
// here if and when a migrated spec's dependency chain actually needs it,
// rather than pre-aliasing unused specifiers.
//
// `@temporal-contract/contract` is NOT in this list, so it resolves through
// the plain workspace symlink to its BUILT `dist/*.mjs` — not source. This
// tier therefore runs `client` source against `contract` dist, unlike every
// other package pair here. A source edit to `packages/contract/src/**`
// (e.g. probing `reusePolicyFor` for a dedup-suite discrimination check) is
// invisible to `integration-inprocess` until `pnpm --filter
// @temporal-contract/contract build` reruns — silently testing stale
// behavior otherwise. Hit and documented in the idempotency task-3 report.
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
