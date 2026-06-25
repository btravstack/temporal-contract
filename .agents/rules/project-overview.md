# Project Overview

**temporal-contract** is a type-safe contract system for Temporal.io workflows and activities.

## Architecture

- Monorepo managed with **pnpm workspaces** and **Turborepo**
- Packages publish to npm under the `@temporal-contract/` scope
- Uses **Standard Schema** (Zod, Valibot, ArkType) for runtime validation
- Uses **Result/ResultAsync** pattern (via `neverthrow`) instead of throwing exceptions

## Repo Layout

| Directory   | Purpose                                                                               |
| ----------- | ------------------------------------------------------------------------------------- |
| `packages/` | Published `@temporal-contract/*` packages (the four below)                            |
| `examples/` | `private: true` sample apps (`@temporal-contract/sample-*`) that consume the packages |
| `tools/`    | Shared workspace configs (`tsconfig`, `typedoc`) — also `private: true`               |
| `docs/`     | VitePress site (`btravstack.github.io/temporal-contract`)                             |

## Published Packages

| Package    | Canonical entry point                               | Purpose                                                    |
| ---------- | --------------------------------------------------- | ---------------------------------------------------------- |
| `contract` | `packages/contract/src/builder.ts`                  | Contract builder (`defineContract`) and type definitions   |
| `worker`   | `packages/worker/src/{activity,workflow,worker}.ts` | Type-safe worker, workflow declarations, activity handlers |
| `client`   | `packages/client/src/client.ts`                     | Type-safe client for consuming workflows via `ResultAsync` |
| `testing`  | `packages/testing/src/global-setup.ts`              | Testing utilities (global setup, Temporal test server)     |

## Key Concepts

- **Contract** — defines task queue, workflows, activities, signals, queries, updates, search attributes with schemas. See [contract-patterns.md](./contract-patterns.md).
- **Worker** — `declareWorkflow` + `declareActivitiesHandler` with automatic validation. See [handlers.md](./handlers.md).
- **Client** — `TypedClient.create()` returns `ResultAsync<T, E>` for all operations.
- **Result** — `Result<T, E>` and `ResultAsync<T, E>` from neverthrow for explicit error handling.
- **Determinism** — workflow code runs in Temporal's replay sandbox. See [workflow-determinism.md](./workflow-determinism.md).
