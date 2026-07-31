---
"@temporal-contract/contract": major
"@temporal-contract/client": major
"@temporal-contract/worker": major
"@temporal-contract/testing": major
---

v8 audit remediation — a second full-surface pass hardening robustness, the unthrown integration, developer experience, and btravstack-family consistency before 8.0 stabilises.

**All packages.**

- ESM-only everywhere: `@temporal-contract/client` and `@temporal-contract/worker` drop their CJS output and legacy `main`/`module`/`types` fields; all four packages verify with `attw --profile esm-only`.
- `@temporalio/*` peer ranges tightened from `^1` to `^1.16.0` — the real floor for the Schedule API and the top-level `@temporalio/common` search-attribute imports.
- Error tags are exported as literal-typed constants (`CONTRACT_ERROR_TAG`, `ACTIVITY_ERROR_TAG`, `WORKFLOW_FAILED_ERROR_TAG`, …) so consumers match with `P.tag(CONST)` instead of hand-written strings; the classes consume the constants so tag and constant cannot drift.

**`@temporal-contract/contract`:**

- Type-helper renames to the family-standard `Infer*` prefix: `SignalNamesOf`/`QueryNamesOf`/`UpdateNamesOf`/`DeclaredErrorsOf` → `InferSignalNames`/`InferQueryNames`/`InferUpdateNames`/`InferDeclaredErrors`.
- `defineActivity`'s `defaultOptions` key is renamed `activityOptions` (merge precedence unchanged), and its type `ActivityDefaultOptions` → `ContractActivityOptions` — the new name keeps the contract-level, portable subset distinct from Temporal's own `ActivityOptions`, which is what the worker-side `activityOptionsByName` overrides take.
- Duration strings are validated against the `ms` grammar at `defineContract` time — `"5 minutos"`, `""`, and negative durations now fail at definition, naming the offending path, instead of at the worker.
- Temporal-reserved names are rejected at `defineContract`: the `__temporal_` prefix and the exact `__stack_trace` / `__enhanced_stack_trace` query names.
- Activity-only contracts are allowed — `workflows` may be `{}` when at least one global activity is declared (dedicated activity-pool task queues).
- The typed-error wire encoding carries a provenance marker (`details[1] = { $tc: 1 }`). Data-less declared errors now require the marker to rehydrate, closing a false positive where any `ApplicationFailure` sharing a declared error's `type` string was surfaced as the typed domain error. A degrade-to-generic rehydration miss fires the new `onRehydrationMiss` diagnostic hook instead of failing silently.
- The `/result-async` subpath is removed; the `_internal_*` helpers move behind a dedicated `@temporal-contract/contract/internal` subpath (not a public API).

**`@temporal-contract/worker`:**

- A shared activity referenced from several contract scopes must be implemented once at the global level or with the same function reference; two different implementations for one flattened name now throw at declaration time (previously the last one silently clobbered the rest).
- The in-workflow handler binders are renamed to the `handle*` convention: `context.defineSignal`/`defineQuery`/`defineUpdate` → `context.handleSignal`/`handleQuery`/`handleUpdate` (no collision with the contract-authoring `define*` helpers or Temporal's own functions).
- Previously-internal types are now exported so implementations can be factored out of the `declareWorkflow`/`declareActivitiesHandler` calls: `WorkflowContext`, `DeclareWorkflowOptions`, `WorkflowImplementation`, the child-workflow handle types, the signal/query/update handler-implementation types, `WorkflowInferActivity`, `DeclareActivitiesHandlerOptions`, `TypedContinueAsNewOptions`, plus the new `ActivityImplementationFor` / `GlobalActivityImplementationFor` helpers.
- `qualifyFailure(errorType, options)` requires an `expected` discriminator (an error class, an array of classes, a predicate, or the explicit literal `"any"`). Causes matching `expected` are wrapped into the modeled `ApplicationFailure`; everything else — a `TypeError` from a bug, say — rides the **defect** channel instead of being mislabelled a business error. A matched inner `ApplicationFailure` with `nonRetryable: true` is inherited by default.
- New `rethrowCancellation(error)` helper. When an activity declares an `errors` map, cancellation surfaces as `Err(ActivityCancelledError)`; generic error handling that folds every `Err` to a fallback would complete the workflow instead of cancelling it. The cancellation error classes' JSDoc documents the hazard and the helper.
- Async query/update schemas are rejected at bind time (`ContractMisuseError`) rather than on the first live request.
- `context.continueAsNew` can no longer have its validated `workflowType`/`taskQueue` overridden through the options bag.
- `ChildWorkflowError` carries a structured `workflowName`; the input/output `ValidationError` subclasses carry a `readonly direction: "input" | "output"`.
- `TypedWorker.create` verifies workflow registration by default — a contract workflow missing from the `workflowsPath` bundle, or an export whose name differs from its `workflowName`, fails creation with a contract-aware message. Opt out with `verifyWorkflowRegistration: false`.

**`@temporal-contract/client`:**

- Workflow outcomes are first-class typed errors on `executeWorkflow`/`handle.result()`: `WorkflowCancelledError`, `WorkflowTerminatedError`, `WorkflowTimeoutError` (each retaining the original `TemporalFailure` as `cause`) — no more `err.cause instanceof CancelledFailure` digging the matcher can't see.
- Update and query operational failures are modeled instead of leaking as defects: `UpdateFailedError`, `UpdateRejectedError`, `QueryFailedError` (the last covering Temporal's `QueryNotRegisteredError`).
- `P`-composable tag bundles (`WORKFLOW_START_ERROR_TAGS`, `WORKFLOW_OUTCOME_ERROR_TAGS`, `WORKFLOW_RESULT_ERROR_TAGS`) and a `tagPatterns(tags)` helper collapse the recurring multi-tag `match` arms.
- `handle.raw` exposes the underlying `@temporalio/client` `WorkflowHandle`.
- `ContractClient` and `TypedScheduleClient` are no longer constructible directly (use `typedClient.for(...)` / the schedule accessor); `ContractClient` exposes readonly `contract` and `taskQueue` getters.
- Client interceptors may patch only `input`/`signalInput`, never identity fields such as `workflowName`.
- `TypedScheduleHandle.update()` validates the updated action's `args` against the contract when its `workflowType` is a declared workflow. Invalid `DATETIME` search-attribute values (`new Date(NaN)`) are rejected.
- Internals: the imperative `assertNoDefect` thunks are replaced with `AsyncResult` combinator chains, so defects flow through channels without manual re-wrapping.

**`@temporal-contract/testing`:**

- The factories move to the family option-bag convention: `createContractTest({ contract, workflowsPath, ... })` and `runActivity(definition, { implementation, input, env? })`.
- New `runActivityHandler(definition, { ... })` routes through the real `declareActivitiesHandler` wrapping — input parse, output validation, contract-error wire conversion, and rehydration — so a test exercises what production does, not just the raw implementation.
- `@unthrown/vitest` is wired in; the package's assertions use `toBeOk`/`toBeErrTagged`/`toBeDefect`.
- `testcontainers` is now an optional peer dependency, required only for `createContractTest`; the Docker-free `/time-skipping` and `/activity` entries no longer pull it in.
