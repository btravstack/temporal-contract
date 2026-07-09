---
"@temporal-contract/testing": major
"@temporal-contract/client": patch
"@temporal-contract/contract": patch
"@temporal-contract/worker": patch
---

Audit fixes across the published packages.

**Breaking (`@temporal-contract/testing`):** `@temporalio/client` and
`@temporalio/worker` moved from `dependencies` to `peerDependencies` (`^1`).
Both packages' types are exposed through the public `it` fixture
(`Connection` / `NativeConnection`), so consumers must resolve them to a
single instance to avoid disjoint nominal types. Package managers that
auto-install peers (npm 7+, pnpm with `autoInstallPeers`) are unaffected;
other setups must add the two packages explicitly — any project using this
testing helper already depends on them in practice. The stale `config` entry
was also dropped from `files`.

**All packages:** `sideEffects: false` is now declared, enabling bundler
tree-shaking. The worker package's `createTypedChildHandle` no longer uses
`any` internally, and JSDoc examples were fixed to use ESM-correct imports
(`.js` extensions, `workflowsPathFromURL` instead of `require.resolve`).
