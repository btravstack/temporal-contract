# Project Overview

**temporal-contract** is a type-safe contract system for Temporal.io workflows and activities.

## Architecture

- Monorepo managed with **pnpm workspaces** and **Turborepo**
- Packages publish to npm under the `@temporal-contract/` scope
- Uses **Standard Schema** (Zod, Valibot, ArkType) for runtime validation
- Uses **Result/ResultAsync** pattern (via `neverthrow`) instead of throwing exceptions

## Package Map

| Package    | Purpose                                                    |
| ---------- | ---------------------------------------------------------- |
| `contract` | Contract builder (`defineContract`) and type definitions   |
| `worker`   | Type-safe worker, workflow declarations, activity handlers |
| `client`   | Type-safe client for consuming workflows via ResultAsync   |
| `testing`  | Testing utilities (global setup, Temporal test server)     |

## Key Concepts

- **Contract** — defines task queue, workflows, activities, signals, queries, updates with schemas
- **Worker** — `declareWorkflow` + `declareActivitiesHandler` with automatic validation
- **Client** — `TypedClient.create()` returns `ResultAsync<T, E>` for all operations
- **Result** — `Result<T, E>` and `ResultAsync<T, E>` from neverthrow for explicit error handling
