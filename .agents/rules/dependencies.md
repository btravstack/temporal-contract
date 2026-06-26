# Dependencies

## Key Dependencies

| Dependency              | Where it's used                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `@temporalio/client`    | Temporal client SDK — peer dep of `client`                                                                                       |
| `@temporalio/worker`    | Temporal worker SDK — peer dep of `worker`                                                                                       |
| `@temporalio/workflow`  | Temporal workflow API — peer dep of `worker`                                                                                     |
| `@temporalio/common`    | Shared Temporal types — peer dep of `client`/`worker`                                                                            |
| `@standard-schema/spec` | Standard Schema specification — direct dep                                                                                       |
| `unthrown`              | `Result` / `AsyncResult` — peer dep of `client`/`worker`                                                                         |
| `zod`                   | Direct dep of `contract` (used internally for the `defineContract` runtime validation pass); user-side schema lib for the others |
| `valibot` / `arktype`   | User-side schema libraries (Standard Schema)                                                                                     |

`pino` and `ts-pattern` appear in the catalog and are used by `examples/` only — they're not imported from any published package's `src/`.

## Tooling

| Tool         | Purpose                            |
| ------------ | ---------------------------------- |
| `pnpm`       | Package manager (workspaces)       |
| `turbo`      | Monorepo build orchestration       |
| `tsdown`     | TypeScript bundler                 |
| `vitest`     | Test framework                     |
| `oxlint`     | Linter                             |
| `oxfmt`      | Formatter (import sorting, JSON)   |
| `knip`       | Unused export/dependency detection |
| `lefthook`   | Git hooks                          |
| `changesets` | Version management                 |

## Version Catalog

All dependency versions are centralized in `pnpm-workspace.yaml` under the `catalog:` key. Packages reference versions with the `"catalog:"` protocol. Always edit the catalog rather than per-package versions.

## Peer Dependencies

Anything that appears in a published package's **public type signatures** must be a peer dep, not a regular dep — otherwise downstream consumers can end up with two disjoint nominal types in their typechecker (theirs and ours), even though the runtime classes are compatible.

| Package  | Peer dependencies                                                                            |
| -------- | -------------------------------------------------------------------------------------------- |
| client   | `@temporalio/client ^1.16.0`, `@temporalio/common ^1`, `unthrown ^0.1`                       |
| worker   | `@temporalio/common ^1`, `@temporalio/worker ^1`, `@temporalio/workflow ^1`, `unthrown ^0.1` |
| contract | none (pure type definitions)                                                                 |
| testing  | `vitest ^4` (the `globalSetup` hook integrates with vitest's test runner)                    |

When you add a peer dep, also add it to `devDependencies` (with the same `"catalog:"` reference) so the local workspace build still resolves it. The workspace has `autoInstallPeers: false`, so peers must be present somewhere on the install side.

## `pnpm.overrides` (root `package.json`)

The root `package.json` pins minimum versions for transitive dependencies via `pnpm.overrides` to close known CVEs (`lodash`, `lodash-es`, `picomatch`, `preact`, `protobufjs`, `rollup`, `serialize-javascript`, `vite`). When a security audit flags a new vulnerability, add the pin here rather than waiting for upstream to update.

## Monorepo Conventions

- Internal packages use `"workspace:*"` protocol
- All published packages are scoped under `@temporal-contract/`
- Examples use `@temporal-contract/sample-*` naming and are marked `"private": true`
- Shared configs live in `tools/` (`tsconfig`, `typedoc`)
