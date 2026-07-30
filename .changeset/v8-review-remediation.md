---
"@temporal-contract/contract": major
"@temporal-contract/client": major
"@temporal-contract/worker": major
"@temporal-contract/testing": major
---

v8 review remediation — the full-surface overhaul from the six-track 8.0 review. Headline breaks, per package:

**All boundaries (client + worker):** payloads are now parsed exactly once, on the receiving side. The sender still validates (surfacing a typed `Err`/`ValidationError` early) but transmits the caller's original value, so transforming schemas (`z.coerce.*`, `.transform(...)`) apply once end-to-end instead of twice.

**`@temporal-contract/contract`:**

- `defineContract`'s structural validation is hand-rolled and strict (unknown keys rejected); the zod runtime dependency is gone.
- `input` is optional on signal/query/update definitions — `defineSignal()` / `defineQuery({ output })` with no input means the handler receives `undefined`, no `z.void()` ceremony.
- ESM-only build (the CJS artifacts and `main`/`module`/`require` conditions are removed).
- `InferContractWorkflows` is deleted (trivial alias).

**`@temporal-contract/client`:**

- `TypedClient` is split from the contract: `TypedClient.create({ client })` is connection-scoped, and `typedClient.for(contract)` returns the contract-bound `ContractClient` with the workflow/schedule methods. A `readonly raw` escape hatch exposes the underlying `Client`.
- `getHandle` is synchronous, returns `Result<TypedWorkflowHandle, WorkflowNotInContractError>`, and accepts `runId`/`firstExecutionRunId` options; handles carry `runId`/`firstExecutionRunId`; typed `startUpdate` joins `executeUpdate`.
- `WorkflowNotFoundError` is renamed `WorkflowNotInContractError`.
- Schedule surface parity: typed `ScheduleAlreadyExistsError`/`ScheduleNotFoundError` on the error channel (instead of defects), plus `update`, `backfill`, and `list`.
- The six unused `ClientInfer*` type exports are deleted.

**`@temporal-contract/worker`:**

- Invalid signal payloads are dropped and logged (`log.warn`), never thrown — `SignalInputValidationError` is deleted; a stale client can no longer terminally kill a workflow execution.
- Contract misuse inside workflow code (unknown signal/query/update or workflow name, async schema, uncovered activity options) now fails fast as a non-retryable `ContractMisuseError` `ApplicationFailure` instead of hanging executions in Workflow Task retries.
- Exported `qualify` is renamed `qualifyFailure` (no alias), and the deprecated `createWorkerOrThrow` is removed — use `createWorker(...).get()`.
- `activities` is optional on `createWorker`, and activity-less workflows no longer need `{}` entries in the implementations map.
- `TypedChildWorkflowHandle` gains a typed `signals` map and `firstExecutionRunId`.

**`@temporal-contract/testing`:**

- New contract-aware fixtures: `createContractTest(contract, { workflowsPath, activities?, workerOptions? })` yields `{ client, typedClient, worker }` against the testcontainers server, and `runActivity(definition, implementation, input, { env? })` runs one implementation inside `MockActivityEnvironment` (vitest-free).
- Configurable environments: `createTimeSkippingTest(options?)` / `createTimeSkippingEnvironment(options?)` forward `TimeSkippingTestWorkflowEnvironmentOptions`; `createGlobalSetup({ postgresImage?, temporalImage?, temporalEnv?, quiet? })` pins container images and env.
- The package now peer-depends on `@temporal-contract/contract`, `@temporal-contract/client`, `@temporal-contract/worker`, and `unthrown`.
