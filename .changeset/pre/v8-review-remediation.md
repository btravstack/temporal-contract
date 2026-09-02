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
- `CreateTypedClientOptions` is renamed `CreateClientOptions` — the family-shared name for the `Typed*.create()` options shape (matching amqp-contract).
- Schedule surface parity: typed `ScheduleAlreadyExistsError`/`ScheduleNotFoundError` on the error channel (instead of defects), plus `update`, `backfill`, and `list`.
- The six unused `ClientInfer*` type exports are deleted.

**`@temporal-contract/worker`:**

- Invalid signal payloads are dropped and logged (`log.warn`), never thrown — `SignalInputValidationError` is deleted; a stale client can no longer terminally kill a workflow execution.
- Contract misuse inside workflow code now raises a typed, non-retryable `ContractMisuseError` `ApplicationFailure` instead of a bare `Error`. The runtime consequence differs by where the misuse is caught: binding a handler for an unknown signal/query/update, or an async schema where Temporal requires synchronous validation, is caught from inside the running implementation and **fails the execution terminally**. An unknown workflow name or an activity whose options are unbounded is caught inside `declareWorkflow` at module top level, before Temporal invokes the workflow function — a throw there is a Workflow Task failure regardless of error class (`nonRetryable` never reaches a `FailWorkflowExecution` command), so it **stalls** the execution via workflow-task retry. That is deliberate: it lets a fix-and-redeploy recover in-flight executions.
- Exported `qualify` is renamed `qualifyFailure` (no alias), and the deprecated `createWorkerOrThrow` is removed — use `createWorker(...).get()`.
- `defineActivityMiddleware` is renamed `declareActivityMiddleware` — the family convention is `define*` for contract authoring and `declare*` for implementation-side APIs, and middleware was the one implementation-side holdout.
- `activities` is optional on `createWorker`, and activity-less workflows no longer need `{}` entries in the implementations map.
- `TypedChildWorkflowHandle` gains a typed `signals` map and `firstExecutionRunId`.

**`@temporal-contract/testing`:**

- New contract-aware fixtures: `createContractTest(contract, { workflowsPath, activities?, workerOptions? })` yields `{ client, typedClient, worker }` against the testcontainers server, and `runActivity(definition, implementation, input, { env? })` runs one implementation inside `MockActivityEnvironment` (vitest-free).
- Configurable environments: `createTimeSkippingTest(options?)` / `createTimeSkippingEnvironment(options?)` forward `TimeSkippingTestWorkflowEnvironmentOptions`; `createGlobalSetup({ postgresImage?, temporalImage?, temporalEnv?, quiet? })` pins container images and env.
- The package now peer-depends on `@temporal-contract/contract`, `@temporal-contract/client`, `@temporal-contract/worker`, and `unthrown`.
- The time-skipping `testEnv` fixture is correctly typed (the fixture record previously declared a phantom `$worker` key, leaving `testEnv` untyped in consuming suites).
