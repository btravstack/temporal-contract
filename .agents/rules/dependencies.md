# Dependencies

## Key Dependencies

| Dependency                    | Purpose                       |
| ----------------------------- | ----------------------------- |
| `@temporalio/client`          | Temporal client SDK           |
| `@temporalio/worker`          | Temporal worker SDK           |
| `@temporalio/workflow`        | Temporal workflow API         |
| `@standard-schema/spec`       | Standard Schema specification |
| `neverthrow`                  | Result and ResultAsync types  |
| `zod` / `valibot` / `arktype` | Schema validation libraries   |
| `pino`                        | Structured logging            |

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

All dependency versions are centralized in `pnpm-workspace.yaml` under the `catalog:` key. Packages reference versions with `"catalog:"` protocol.

## Monorepo Conventions

- Internal packages use `"workspace:*"` protocol
- All packages are scoped under `@temporal-contract/`
- Shared configs live in `tools/` (tsconfig, typedoc)
