# Dependencies

## Key Dependencies

| Dependency              | Where it's used                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `@temporalio/client`    | Temporal client SDK — peer dep of `client`                                                                                  |
| `@temporalio/worker`    | Temporal worker SDK — peer dep of `worker`                                                                                  |
| `@temporalio/workflow`  | Temporal workflow API — peer dep of `worker`                                                                                |
| `@temporalio/common`    | Shared Temporal types — peer dep of `client`/`worker`                                                                       |
| `@temporalio/testing`   | Time-skipping test server (`TestWorkflowEnvironment`) — peer dep of `testing`                                               |
| `@standard-schema/spec` | Standard Schema specification — direct dep                                                                                  |
| `unthrown`              | `Result` / `AsyncResult` — peer dep of `client`/`worker`                                                                    |
| `zod`                   | User-side schema library (Standard Schema); dev-only in this repo — `defineContract`'s structural validation is hand-rolled |
| `valibot` / `arktype`   | User-side schema libraries (Standard Schema)                                                                                |

`pino` appears in the catalog and is used by `examples/` only — it's not imported from any published package's `src/`.

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

## TypeScript 7 and `.pnpmfile.cjs`

The workspace compiles and type-checks with TypeScript 7 (the Go port), whose `typescript` package no longer ships the JS compiler API. Tools built on that API — `typedoc` and `rolldown-plugin-dts` (tsdown's `--dts`) — get `@typescript/typescript6` in place of their `typescript` peer through the `readPackage` hook in `.pnpmfile.cjs`. The published `.d.ts` files are therefore emitted by TS 6; drop a tool from the hook once it supports TS 7.

## Peer Dependencies

Anything that appears in a published package's **public type signatures** must be a peer dep, not a regular dep — otherwise downstream consumers can end up with two disjoint nominal types in their typechecker (theirs and ours), even though the runtime classes are compatible.

| Package  | Peer dependencies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| contract | `unthrown ^5.0.0` (optional — only needed when using the `/errors` or `/internal` entry points)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| client   | `@temporal-contract/contract ^8.x`, `@temporalio/client ^1.24.0`, `@temporalio/common ^1.24.0`, `unthrown ^5.11.0`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| worker   | `@temporal-contract/contract ^8.x`, `@temporalio/common ^1.24.0`, `@temporalio/worker ^1.24.0`, `@temporalio/workflow ^1.24.0`, `unthrown ^5.11.0`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| testing  | `@temporal-contract/client`, `@temporal-contract/contract`, `@temporal-contract/worker` (concrete `^8.x` ranges — see below), `@temporalio/client ^1.24.0`, `@temporalio/worker ^1.24.0`, `unthrown ^5.11.0` (all exposed by the fixtures' public types); optional: `@temporalio/testing ^1.24.0` (only `/activity`, `/time-skipping` and `/test-rig` use it), `vitest ^4 \|\| ^5` (every entry except `/activity` and `/workflow-bundle`, which stay runner-agnostic), `testcontainers ^12` (only `/global-setup`, loaded lazily with a descriptive error when missing) |

The `@temporalio/*` peer floor is `^1.24.0` across client, worker and testing, and `unthrown`'s is `^5.11.0` — the versions the workspace builds and tests against. Keep them in sync across the packages when raising them. The contract package's optional `unthrown` peer stays at `^5.0.0`.

The `@temporal-contract/contract` peers of client and worker are concrete `^8.x` ranges with a `workspace:*` devDependency for local resolution.

**Deliberate exception — `@standard-schema/spec`:** it appears in public type signatures (e.g. `StandardSchemaV1.Issue` on validation errors) but stays a **regular dep**, not a peer. It is a types-only structural package — no runtime code and no nominal classes, so the "two disjoint nominal types" failure mode above cannot occur: any two copies of the spec are structurally identical to the typechecker. Making it a peer would only push install churn onto consumers for zero benefit.

When you add a peer dep, also add it to `devDependencies` (with the same `"catalog:"` reference) so the local workspace build still resolves it. The workspace has `autoInstallPeers: false`, so peers must be present somewhere on the install side.

**Deliberate exception:** the testing package's `@temporal-contract/*` sibling peers have NO matching devDeps. client and worker devDepend on testing for their integration fixtures, so adding the siblings to testing's devDeps would put a cycle in the package graph, which turbo 2 rejects. Local resolution goes through tsconfig `paths` mapped to the siblings' sources plus vitest aliases instead — see the comments in `packages/testing/tsconfig.json` and `packages/testing/vitest.config.ts`. For the same reason these peers use **concrete `^8.x` semver ranges, not `workspace:^`**: pnpm can only rewrite the `workspace:` protocol at pack/publish time for deps that are actually installed, so `workspace:^` here breaks `pnpm pack`/`pnpm publish` (`ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`). Changesets keeps the ranges bumped (`updateInternalDependencies: "patch"`, and the four packages are a fixed group).

## Security `overrides` (`pnpm-workspace.yaml`)

`pnpm-workspace.yaml` pins minimum versions for vulnerable transitive dependencies via its `overrides:` block. When a security audit flags a new vulnerability, add the pin there — version-scoped to the affected major line, with a comment citing the GHSA and how the package reaches us — rather than waiting for upstream to update. Raise an existing pin's floor instead of adding a second overlapping range.

## Monorepo Conventions

- Internal packages use `"workspace:*"` protocol
- All published packages are scoped under `@temporal-contract/`
- Examples use `@temporal-contract/sample-*` naming and are marked `"private": true`
- Shared configs come from the org's packages: `@btravstack/tsconfig` (every package `extends` `@btravstack/tsconfig/base.json`) and `@btravstack/typedoc`
