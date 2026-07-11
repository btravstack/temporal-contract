---
"@temporal-contract/client": major
"@temporal-contract/worker": major
"@temporal-contract/contract": minor
"@temporal-contract/testing": minor
---

Cross-project DNA alignment with amqp-contract (#301, #302, #303, #304).

**Breaking — AsyncResult-returning creation (#301).** The runtime factories now model creation failures on the `Err` channel instead of throwing, matching the org-wide `Typed*.create()` shape:

- `TypedClient.create({ contract, client, interceptors? })` → `AsyncResult<TypedClient, TechnicalError>` (single options object; surfaces a missing Schedule API and eager-connection failures via `connection.ensureConnected`).
- `createWorker(options)` → `AsyncResult<Worker, TechnicalError>` (bundling/connection failures modeled).
- `TechnicalError` (tag `@temporal-contract/TechnicalError`) is exported from `@temporal-contract/contract/errors` and re-exported by client and worker.
- Migration: deprecated throwing aliases `TypedClient.createOrThrow(contract, client)` and `createWorkerOrThrow(options)` preserve the old behavior and will be removed in a future major.

**Breaking — unified context model (#302).** `declareActivitiesHandler`'s middleware option now takes a **single** middleware (compose chains with `composeActivityMiddleware(...)`, outermost-first) instead of an array, and `next` takes an object patch:

- `next({ context })` extends the typed context flowing downstream (shallow-merged; bounded generics `TContextOut extends TContextIn` accumulate across `composeActivityMiddleware`'s overloads — amqp-contract's model). `defineActivityMiddleware` pins a middleware's context types; `EmptyContext` is the empty seed.
- `next({ input })` replaces the positional `next(input)` substitution (still re-validated against the contract schema).
- `createContext` now seeds the accumulated context; `helpers.context` is the seed plus every middleware injection (an empty object when unconfigured, no longer `undefined`).
- **Client interceptors**: `TypedClient.create({ interceptors })` wraps `startWorkflow` / `executeWorkflow` / `signalWithStart` and handle-level `signal` / `query` / `update`, outermost-first, outside validation — patch args via `next({ input })`, retry by calling `next` again, short-circuit by returning without calling `next`.
- The demesne `Layer.forkScope` recipe is documented as the recommended `createContext` engine for scoped, resource-releasing contexts.

**Testing — in-process story (#303).** New `@temporal-contract/testing/time-skipping` entry point: a Vitest fixture (`it` with a worker-scoped `testEnv`) plus `createTimeSkippingEnvironment()` wrapping Temporal's time-skipping `TestWorkflowEnvironment` — full contract-pipeline tests (validation, middleware, typed errors, rehydration) without Docker. `@temporalio/testing ^1` is a new peer dependency of the testing package.

**Consistency cleanup (#304).** `activityOptions` on `declareWorkflow` is now optional when every reachable activity carries contract-level `defaultOptions` (or an `activityOptionsByName` entry) — a descriptive declaration-time error lists uncovered activities otherwise. The direction-aware inference primitives (`ClientInferInput` / `ClientInferOutput` / `WorkerInferInput` / `WorkerInferOutput`) are centralized in `@temporal-contract/contract` (worker/client re-export them unchanged). The obsolete `migrating-to-neverthrow` guide is removed, stale JSDoc fixed, and docs/examples adopt the composition-first rule (define resources first, then reference them in `defineContract`).
