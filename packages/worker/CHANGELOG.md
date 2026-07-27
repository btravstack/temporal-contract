# @temporal-contract/worker

## 8.0.0-beta.1

### Patch Changes

- 75ec554: Bump `unthrown` to `5.0.0-beta.5`. This tracks two beta breaking changes:
  `match`'s error handler key is renamed `err` → `errCases`, and the bare error
  combinators gained the `*Cases` suffix (`flatMapErr` → `flatMapErrCases`,
  `tapErr` → `tapErrCases`). `unthrown` also now declares `ts-pattern` as a peer
  dependency, so `ts-pattern` (`^5`) is added alongside it. The peer range is
  raised to `^5.0.0-beta.5`.
- fff11ff: Bump `unthrown` to `5.0.0-beta.6`, whose exhaustive matcher is now built-in
  (same `.with(…)` / `tag` / `P` call-site shape — no code changes needed). The
  `ts-pattern` peer/dev dependencies added for beta.5 are removed: `unthrown` has
  zero runtime dependencies, so nothing needs installing alongside it. The
  `unthrown` peer range is raised to `^5.0.0-beta.6`.
- efec2b2: Route `TechnicalError` and `RuntimeClientError` to unthrown's defect channel instead of the modeled `Err` channel.

  These two errors describe technical/infrastructure failures (connection/bundling faults, an unknown schedule ID, an unrecognized Temporal rejection) that are never branched on for domain logic. Per unthrown's Thesis #1, the `E` channel is only for anticipated domain failures, so they now surface as a `Defect` whose `cause` is a `TechnicalError` / `RuntimeClientError` instance — the classes stay exported so the descriptive message, `operation`, and `cause` survive for logging.

  **Breaking.** Consumers who matched these on the error channel must move to the defect channel:

  - `TypedClient.create` and `createWorker` now return `AsyncResult<_, never>` (was `AsyncResult<_, TechnicalError>`). Inspect setup faults via `result.isDefect()` / `match`'s `defect` handler / `recoverDefect`, not `isErr()`.
  - Every modeled error union drops `RuntimeClientError` (`startWorkflow`, `signalWithStart`, `executeWorkflow`, `getHandle`, handle `queries`/`signals`/`updates`/`result`/`terminate`/`cancel`/`describe`/`fetchHistory`, the schedule handle methods, `ClientCallError`). Schedule handle methods now return `AsyncResult<_, never>`.
  - Drop any `.with(tag("@temporal-contract/RuntimeClientError"), …)` / `.with(tag("@temporal-contract/TechnicalError"), …)` arm from exhaustive matchers; handle these in the `defect` arm (e.g. `recoverDefect` / `tapDefect`), matching on `cause instanceof RuntimeClientError` where needed.

- Updated dependencies [75ec554]
- Updated dependencies [fff11ff]
- Updated dependencies [efec2b2]
  - @temporal-contract/contract@8.0.0-beta.1

## 8.0.0-beta.0

### Major Changes

- 890d49a: Adopt unthrown v5 (beta): the error combinators and `match`'s `err` handler now take a ts-pattern matcher callback; peer bumped to `^5.0.0-beta.3`.

### Patch Changes

- Updated dependencies [5fc2359]
- Updated dependencies [890d49a]
- Updated dependencies [74433ea]
  - @temporal-contract/contract@8.0.0-beta.0

## 7.0.0

### Major Changes

- dc4a0cd: Cross-project DNA alignment with amqp-contract (#301, #302, #303, #304).

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

### Minor Changes

- 52d4c01: Contract-declared typed domain errors, activity middleware + typed dependency context, and contract-level default activity options.

  - **Typed domain errors** — `defineActivity` / `defineWorkflow` accept an `errors` map (`{ data?: StandardSchema, message?, nonRetryable? }` per name). Activity implementations receive typed constructors via a new helpers argument (`(args, { errors }) => Err(errors.PaymentDeclined({ reason }))`); the worker serializes them as `ApplicationFailure` (`type` = error name, `details[0]` = validated payload, `nonRetryable` from the contract). On the workflow side, errors-declaring activities now return `AsyncResult<Output, ContractError union | ActivityError | ActivityCancelledError>` (mirroring the child-workflow API); activities without declared errors keep the throwing `Promise` shape. Workflows can declare their own errors and fail with `throw context.errors.X(data)`; the typed client rehydrates matching failures into `ContractError` on `executeWorkflow` and `handle.result()`. New `@temporal-contract/contract/errors` entry point exports `ContractError` and the supporting types.
  - **Activity middleware + typed context** — `declareActivitiesHandler` accepts `createContext` (typed dependency injection, surfaced to implementations as `helpers.context`) and `middleware` (contract-aware chain running inside the validation boundary, operating on the unthrown `AsyncResult`).
  - **Contract-level activity option defaults** — `defineActivity` accepts `defaultOptions` (timeouts, retry policy). Merge precedence at the worker: `declareWorkflow` `activityOptions` < contract `defaultOptions` < `activityOptionsByName`.

### Patch Changes

- 1ec704a: Require unthrown >= 4.1.0 (peer range `^4` → `^4.1.0`).

  unthrown 4.1 renames several operators and deprecates the old aliases (`orElse` → `flatMapErr`, `recover` → `recoverErr`, `unwrap`/`unwrapErr`/`unwrapOr`/`unwrapOrElse` → `get`/`getErr`/`getOr`/`getOrElse`). The packages' own code never used the deprecated names, so no runtime behavior changes — the docs and guides now reference the new names, and raising the peer minimum guarantees the renamed operators exist for consumers following them.

- Updated dependencies [dc4a0cd]
- Updated dependencies [52d4c01]
- Updated dependencies [1ec704a]
  - @temporal-contract/contract@7.0.0

## 6.1.0

### Minor Changes

- 2960244: Add the `qualify(type, options?)` helper to `@temporal-contract/worker/activity`.

  It builds the qualifier function `fromPromise` needs, replacing the
  `ApplicationFailure.create({ type, message: error instanceof Error ? ... })`
  boilerplate previously repeated in every activity:

  ```ts
  import { declareActivitiesHandler, qualify } from "@temporal-contract/worker/activity";
  import { fromPromise } from "unthrown";

  export const activities = declareActivitiesHandler({
    contract,
    activities: {
      sendEmail: (args) =>
        fromPromise(emailService.send(args), qualify("EMAIL_SEND_FAILED")).map(() => ({
          sent: true,
        })),
    },
  });
  ```

  An `Error` rejection keeps its own message and is preserved as `cause`;
  non-`Error` rejections fall back to `options.message` (or `String(error)`).
  `options.nonRetryable` and `options.details` are forwarded to the failure.
  The qualifier always wraps — even an `ApplicationFailure` rejection — so the
  declared `type` is guaranteed for retry policies.

- d3e71fc: Upgrade the `unthrown` peer dependency to `^4` (from `^3`).

  unthrown 4 is not compatible with unthrown 3 — most notably, `TaggedError`
  now reserves `name` and `message` as payload fields (they are set via
  `Error`, not passed as structured data). The client and worker error classes
  were migrated accordingly; their public shape is unchanged (`_tag`, `name`,
  `message`, and the typed payload fields are all still present and behave
  identically). Consumers must be on `unthrown@4`.

  Released as a minor rather than a major: these packages have no external
  consumers pinned to `unthrown@3`, so the peer-range change carries no
  real-world break. If you depend on `@temporal-contract/{contract,client,worker}`,
  bump `unthrown` to `^4` alongside this release.

### Patch Changes

- 3b88b3f: Audit fixes across the published packages.

  **`@temporal-contract/testing`:** `@temporalio/client` and `@temporalio/worker`
  moved from `dependencies` to `peerDependencies` (`^1`). Both packages' types are
  exposed through the public `it` fixture (`Connection` / `NativeConnection`), so
  consumers must resolve them to a single instance to avoid disjoint nominal
  types. Package managers that auto-install peers (npm 7+, pnpm with
  `autoInstallPeers`) are unaffected; other setups must add the two packages
  explicitly — any project using this testing helper already depends on them in
  practice. Because that install-shape change can require consumer action, this is
  released as a **minor** for `@temporal-contract/testing`. The stale `config`
  entry was also dropped from `files`.

  **All packages:** `sideEffects: false` is now declared, enabling bundler
  tree-shaking. The worker package's `createTypedChildHandle` no longer uses
  `any` internally, and JSDoc examples were fixed to use ESM-correct imports
  (`.js` extensions, `workflowsPathFromURL` instead of `require.resolve`).

- Updated dependencies [3b88b3f]
- Updated dependencies [d3e71fc]
  - @temporal-contract/contract@6.1.0

## 6.0.0

### Major Changes

- 6c79004: Upgrade to [`unthrown`](https://github.com/btravstack/unthrown) 3.0.0.

  The published packages' `unthrown` peer-dependency range moves to `^3`. unthrown 3.0.0's breaking change — removing the standalone `Defect` constructor in favour of a `defect` argument passed into `fromPromise` / `fromThrowable`'s `qualify` callback — does not affect temporal-contract, which never constructs defects (every boundary maps rejections to a modeled error). Everything else we use (`Ok` / `Err`, `TaggedError`, `matchTags`, `fromPromise` / `fromSafePromise`, `result.match({ ok, err, defect })`, `.toAsync()`, and the `result.isOk()` / `isErr()` / `isDefect()` narrowing) is unchanged, so no source changes were required.

  **Breaking for consumers**: bump your own `unthrown` install to `^3`.

### Patch Changes

- Updated dependencies [6c79004]
  - @temporal-contract/contract@6.0.0

## 5.0.0

### Major Changes

- 224e1ae: Upgrade to [`unthrown`](https://github.com/btravstack/unthrown) 2.0.0.

  The published packages' `unthrown` peer-dependency range moves to `^2`. unthrown 2.0.0 is API-compatible for everything temporal-contract uses — the `Ok` / `Err` / `Defect` constructors, `TaggedError`, `matchTags`, `fromPromise` / `fromSafePromise`, `result.match({ ok, err, defect })`, `.toAsync()`, and `result.isOk()` / `isErr()` / `isDefect()` narrowing are all unchanged — so no source changes were required.

  **Breaking for consumers**: bump your own `unthrown` install to `^2`. There are no other code changes.

### Patch Changes

- Updated dependencies [224e1ae]
  - @temporal-contract/contract@5.0.0

## 4.0.0

### Major Changes

- ebf7683: Upgrade to [`unthrown`](https://github.com/btravstack/unthrown) 1.0.0.

  unthrown 1.0.0 renames the result constructors to PascalCase: `ok` → `Ok`, `err` → `Err`, `defect` → `Defect`. All packages are updated, and the `unthrown` peer-dependency range moves to `^1`.

  **Breaking for consumers** who construct results directly (e.g. in activity implementations): replace `ok(value)` / `err(failure)` with `Ok(value)` / `Err(failure)` (and `ok(value).toAsync()` / `err(failure).toAsync()` at promise boundaries), and bump `unthrown` to `^1`. The `result.match({ ok, err, defect })` handler keys are unchanged (they are object keys, not constructors), and `matchTags` / `TaggedError` / `fromPromise` / `fromSafePromise` / `.toAsync()` and the `result.isOk()` / `isErr()` / `isDefect()` narrowing are all unchanged.

  See the [Migrating from neverthrow](https://btravstack.github.io/temporal-contract/guide/migrating-to-unthrown) guide.

### Patch Changes

- Updated dependencies [ebf7683]
  - @temporal-contract/contract@4.0.0

## 3.0.0

### Major Changes

- 8d0750f: Replace `neverthrow` with [`unthrown`](https://github.com/btravstack/unthrown) for the Result/error-handling spine across all packages. This is a breaking change to the public API.

  **What changed**

  - **`ResultAsync<T, E>` → `AsyncResult<T, E>`.** Every activity, workflow-context, child-workflow, schedule, and typed-client method that returned a `ResultAsync` now returns an `AsyncResult`. The `unthrown` peer dependency replaces `neverthrow`.
  - **No `okAsync` / `errAsync`.** Lift a synchronous `Result` with `.toAsync()` instead: `ok(value).toAsync()`, `err(failure).toAsync()`. Promise boundaries use `fromPromise(promise, qualify)` / `fromSafePromise(promise)`.
  - **Narrow before accessing the payload.** Both the `result.isOk()` / `isErr()` / `isDefect()` methods and the matching free functions `isOk(result)` / `isErr(result)` / `isDefect(result)` (imported from `unthrown`) are type guards; the codebase uses the methods. Narrow before touching `.value` / `.error` / `.cause`.
  - **New `defect` channel.** Unanticipated throws (a thrown exception the code did not model) now surface on `unthrown`'s third `defect` channel — inspected via `result.isDefect()` / `result.cause` and re-thrown at the edge — rather than as a typed `err`. Deliberate boundary classification (e.g. mapping a Temporal SDK rejection to `WorkflowExecutionNotFoundError`) still produces a modeled `err`. `result.match({ ok, err, defect })` folds all three.
  - **`WorkflowScopeError` removed.** Non-cancellation errors thrown inside `cancellableScope` / `nonCancellableScope` are unmodeled failures and now ride the `defect` channel. The scopes' error union narrows to `WorkflowCancelledError`.
  - **The client's "unexpected" `RuntimeClientError` wrap is gone.** An unanticipated rejection in a client operation now surfaces as a defect, not a manufactured `RuntimeClientError`. `RuntimeClientError` is still produced by deliberate boundary classification.
  - **Error classes use `TaggedError`.** The worker `WorkerError` hierarchy and the entire client `TypedClientError` hierarchy are now built with `unthrown`'s `TaggedError`, each carrying a `_tag` discriminant (foldable with `matchTags`). The `_tag` is **package-namespaced** — e.g. `"@temporal-contract/WorkflowExecutionNotFoundError"` — so it never collides with a consumer's own tags; each error's `.name` stays the bare class name for readable logs. `ChildWorkflowCancelledError` is now a sibling of `ChildWorkflowError` (distinct `_tag`) rather than a subclass — discriminate on `_tag` / `instanceof ChildWorkflowCancelledError` instead of relying on `instanceof ChildWorkflowError` matching cancellation. The worker's `ValidationError` subclasses are unchanged — they still extend Temporal's `ApplicationFailure` for terminal-failure semantics.

  See the [Migrating from neverthrow](https://btravstack.github.io/temporal-contract/guide/migrating-to-unthrown) guide.

### Patch Changes

- Updated dependencies [8d0750f]
  - @temporal-contract/contract@3.0.0

## 2.4.0

### Minor Changes

- eae7aae: Declare `engines.node: ">=22.19.0"` on every published package. The floor is set by `undici@8` (pulled in transitively by `testcontainers` via `@temporal-contract/testing`), which already fails at runtime on Node ≤22.18 — the engines field just surfaces that reality at install time so consumers get a clear signal instead of a stack trace. Also bumps `@temporalio/*` 1.18.0 → 1.18.1 and `testcontainers` 12.0.1 → 12.0.2 in the catalog.
- 2c18aa4: Make contract validation failures fail the execution terminally instead of hanging the workflow.

  Previously, the worker's runtime validation errors (`WorkflowInputValidationError`, `WorkflowOutputValidationError`, `ActivityInputValidationError`, `ActivityOutputValidationError`, and the signal/query/update equivalents) were plain `Error`s. The TypeScript SDK classifies a non-`TemporalFailure` thrown from workflow code as a _Workflow Task_ failure and retries it indefinitely, so a deterministic validation failure produced a silently _hung_ workflow (stuck `Running`, only a repeating `WorkflowTaskFailed` event) rather than a failed execution. The same hazard applied at the activity boundary, where Temporal's default retry policy is unlimited. See [#251](https://github.com/btravstack/temporal-contract/issues/251).

  These error classes now extend Temporal's `ApplicationFailure` with `nonRetryable: true`. Because contract schemas are static, a validation failure can never pass on retry, so the execution now **fails fast and terminally** with a `WorkflowExecutionFailed` event. The concrete error name is preserved as the failure `type` (e.g. `"WorkflowInputValidationError"`), so it stays discriminable via `failure.type` after crossing Temporal's serialization boundary, and the failing field path remains in the human-readable `message`.

  The error classes keep their names and identity, so existing `instanceof WorkflowInputValidationError` checks (and the new shared `ValidationError` base, now exported from `@temporal-contract/worker/workflow` and `/activity`) continue to work. If you previously wrapped `declareWorkflow(...)` to rethrow these as `ApplicationFailure.nonRetryable` yourself, that workaround is no longer needed.

### Patch Changes

- Updated dependencies [eae7aae]
  - @temporal-contract/contract@2.4.0

## 2.3.1

### Patch Changes

- @temporal-contract/contract@2.3.1

## 2.3.0

### Minor Changes

- 12b860e: Bump runtime dependencies: `testcontainers` 11 → 12 and `@temporalio/*` 1.17 → 1.18 in `@temporal-contract/testing`. Peer ranges (`@temporalio/*` `^1`, `neverthrow` `^8`) are unchanged.

### Patch Changes

- c0b6b0b: Surface the contract's workflow name on the function returned by `declareWorkflow` (previously anonymous). Temporal's `client.workflow.start(fn, …)` reads `fn.name` to derive the workflow type, so callers who passed the declaration by reference — typically tests sidestepping the typed client — hit an empty workflow type. The typed-client and `workflowsPath` paths were unaffected because they resolve workflows by string name.
- Updated dependencies [12b860e]
  - @temporal-contract/contract@2.3.0

## 2.2.0

### Patch Changes

- 45bd7ee: Closes the remaining audit items: documents the activity input/output shape asymmetry, replaces the example `log` Temporal activity with `@temporalio/workflow`'s `log` namespace, and converts test assertions from `expect.objectContaining({ name: "...Error" })` to `toBeInstanceOf(...)` across worker / client / example specs.

  **Audit #15 — example `log` Temporal activity is a footgun.** Calling an activity per log line balloons workflow history, costs money on Temporal Cloud, and replays on every recovery. The example contract no longer declares a `log` activity; the example workflow imports `log` from `@temporalio/workflow` (replay-safe, routed through the worker's configured logger sink) and calls `log.info(...)` / `log.error(...)` / `log.warn(...)` directly. Domain effects still go through activities. Removed the unused `inventoryReservationId` variable while in there.

  **Audit #16 — test assertions on internal shape rather than error class.** Eight sites across `worker/__tests__/worker.spec.ts`, `worker/activity.spec.ts`, `worker/continue-as-new.spec.ts`, `client/__tests__/client.spec.ts`, and the order-processing example's `integration.spec.ts` were asserting on `name: "...Error"` strings instead of the actual error classes. Switched to `toBeInstanceOf(...)`, which catches subclass renames at compile time and matches the contract-not-implementation rule the codebase aspires to.

  **Audit #10 — activity input/output shape asymmetry.** Documented in the JSDoc on `ContractResultActivitiesImplementations` and `ActivitiesHandler`. The asymmetry is intentional and worth keeping: the input you write mirrors the contract's structure (global at root + workflow-local nested under their owning workflow), giving IDE autocomplete that matches `defineContract`; the output is flat because Temporal's worker sees a single namespace at runtime. `defineContract` already enforces no-collisions across global+workflow scopes, so the flat output has no ambiguity.

- a24a2e4: Round-trip typed search attributes; reject undeclared keys; surface a typed reader.

  **Three improvements to the search-attribute story:**

  1. **Schedules now accept typed `searchAttributes`** on `client.schedule.create(...)`. They translate through the same helper as `client.startWorkflow` / `executeWorkflow` and attach to the schedule's `startWorkflow` action so spawned runs are indexed identically to direct starts. Closes a real production gotcha where schedule-spawned workflows silently lost typed indexing.

  2. **Undeclared attribute keys are now rejected with `RuntimeClientError`** instead of being silently dropped. The TypeScript surface already gates the happy path; the runtime check catches typed-escape-hatch cases (`as never`, `as any`, raw-call interop) where a typo would otherwise leave the workflow unindexed without any signal to the caller. The error's `operation` is `"searchAttributes"` so callers can branch on it.

  3. **New public helper `readTypedSearchAttributes(workflowDef, instance)`** exposed from `@temporal-contract/client` — the read-side counterpart to the write-side `searchAttributes` option. Pass it the result of `handle.describe()` (or a schedule's describe) and recover the typed shape:

     ```ts
     const description = await handle.describe();
     if (description.isOk()) {
       const attrs = readTypedSearchAttributes(
         myContract.workflows.processOrder,
         description.value.typedSearchAttributes,
       );
       // attrs.customerId: string | undefined
       // attrs.priority:   number | undefined
     }
     ```

     The Temporal SDK only exposes `.get(key)` requiring callers to reconstruct each `SearchAttributeKey`; this helper does that lookup once for every declared attribute and returns a `Partial<TypedSearchAttributeMap<TWorkflow>>`.

  Internal: `toTypedSearchAttributes` moved from `client.ts` to `internal.ts` so `schedule.ts` can share the implementation. The previous "filters out attribute keys that aren't declared on the workflow at runtime" test was renamed and now asserts the new throw behavior.

- Updated dependencies [45bd7ee]
- Updated dependencies [a24a2e4]
  - @temporal-contract/contract@2.2.0

## 2.1.0

### Minor Changes

- 4401951: Make the worker-side child-workflow error model coherent with the client-side parent-workflow error model, and tighten `WorkflowFailedError.cause` typing.

  **Worker (`@temporal-contract/worker`):**

  - New `ChildWorkflowCancelledError` discriminant — `extends ChildWorkflowError`, so existing `instanceof ChildWorkflowError` checks keep matching cancellations while `instanceof ChildWorkflowCancelledError` lets callers narrow further. Re-exported from `@temporal-contract/worker/workflow`.
  - New `classifyChildWorkflowError` internal helper mirrors the client-side `classifyResultError` pattern: cancellation (via `isCancellation`) takes priority, then `ChildWorkflowFailure → cause` unwrapping, then a generic fallback.
  - `startChildWorkflow` / `executeChildWorkflow` now correctly forward Temporal's nested `ApplicationFailure` / `TimeoutFailure` / `TerminatedFailure` cause through `ChildWorkflowError.cause` instead of wrapping the raw `ChildWorkflowFailure`. Consumers can now match `err.cause instanceof ApplicationFailure` in one step. `ChildWorkflowNotFoundError` is now part of the return-type union.

  **Client (`@temporal-contract/client`):**

  - New public `TemporalFailure` union type re-exported from `@temporalio/common`: `ApplicationFailure | CancelledFailure | TerminatedFailure | TimeoutFailure | ChildWorkflowFailure | ServerFailure | ActivityFailure`.
  - `WorkflowFailedError.cause` re-typed from `unknown` to `TemporalFailure | undefined`. `classifyResultError` already produced this shape at runtime; the type now matches. Consumers can `instanceof`-match the cause directly without a manual narrow.

- 4401951: Close two `ResultAsync` rejection-handling gaps and widen the cancellation-scope error channel so domain errors stay on neverthrow's railway.

  **`@temporal-contract/contract`:**

  - New subpath export `@temporal-contract/contract/result-async` exposing `_internal_makeResultAsync`. This is the helper the client and worker packages already share — moved into `contract` so both consumers and any future first-party packages can use a single source of truth without duplicating it. The helper wraps a `() => Promise<Result<T, E>>` work function so synchronous throws and rejected promises route through a typed `err(...)` instead of leaking as unhandled rejections.
  - `neverthrow` is declared as an **optional peer dependency** (`peerDependenciesMeta.neverthrow.optional: true`). Contract-only consumers who don't import the `/result-async` subpath don't need to install it.

  **`@temporal-contract/worker`:**

  - New `WorkflowScopeError` re-exported from `@temporal-contract/worker/workflow`. Wraps non-cancellation errors thrown inside `cancellableScope` / `nonCancellableScope`; the original error is preserved on `cause`.
  - **Behavior change** for `cancellableScope` and `nonCancellableScope`: non-cancellation errors thrown by `fn` previously propagated as `ResultAsync` rejections (escaping neverthrow's railway). They now resolve to `err(WorkflowScopeError)`, so `result.match(...)` is exhaustive — every failure mode rides the railway. The error channel is widened to `WorkflowCancelledError | WorkflowScopeError`. Callers that relied on the old "let domain errors propagate as rejections" behavior should now branch on `instanceof WorkflowCancelledError` vs `instanceof WorkflowScopeError`.
  - Internal: 5 worker call sites that previously used `new ResultAsync(work())` now use the shared `_internal_makeResultAsync` helper, closing a synchronous-throw gap that the client side had already fixed.

- 4401951: Align with documented Temporal SDK contracts for `proxyActivities` and Update handlers.

  **`proxyActivities` is now hoisted to declaration time.** Previously it was called inside the closure returned from `declareWorkflow`, which meant every workflow invocation re-ran the registration. The Temporal SDK documents `proxyActivities` as a module-scope helper — it registers stub functions and may carry bookkeeping (validator pre-registration, payload-converter caching) that breaks if re-invoked per run. The call now happens once at `declareWorkflow` time.

  The validation wrapper (`createValidatedActivities`) is hoisted alongside it; the resulting `contextActivities` map is `Object.freeze`d before being exposed on the workflow context, and `WorkflowContext.activities` is now typed `Readonly<...>`. This prevents stray mutations in one workflow run from leaking into later runs in the same isolate.

  **Update handlers now use Temporal's `validator` slot.** `bindUpdateHandler` previously ran schema validation inside the async handler body, which meant bad input produced a workflow history event for a rejected update and surfaced as `WorkflowUpdateFailedError` on the client. Validation now runs synchronously in the `validator` passed to `setHandler`, so:

  - Invalid input is rejected at admission time with **no history event written**.
  - Clients receive `WorkflowUpdateValidationRejectedError` (Temporal's admission-rejection error class) instead of `WorkflowUpdateFailedError`. **This is the only consumer-visible change** — handle invalid update input by checking that error class instead.
  - Async input schemas are now rejected with a clear message at handler-binding time (mirroring the existing query-handler guard); use synchronous schemas for update inputs.

  Output validation continues to run inside the handler body, since update output isn't admission-gated.

### Patch Changes

- cc6add7: Expose `formatIssue` and `summarizeIssues` from `@temporal-contract/contract`. Both helpers were previously duplicated between the `client` and `worker` packages (and explicitly hand-synced) — they now live in the contract package as the single source of truth.

  Internal: split `packages/worker/src/workflow.ts` (1019 lines) into focused modules — `child-workflow.ts` (child-workflow types + start/execute helpers) and `activities-proxy.ts` (validated-activities proxy + activity inference types). Public API of the worker package is unchanged. Also extract a `resolveDefinitionAndValidateInput` helper in the client package, used by `startWorkflow` / `signalWithStart` / `executeWorkflow` to share the contract-lookup → input-validation → search-attribute-translation ritual.

- 4401951: Fix two TypeScript soundness bugs and add public name-helper types to `@temporal-contract/contract`.

  **Soundness fixes** (previously made `args: unknown` and accepted any string as a signal name):

  - `WorkflowDefinition` is now parameterized over `<TInput, TOutput, ...>`. Schema literal types flow through `defineWorkflow` so `client.startWorkflow("processOrder", { args: ??? })` infers `args` as the schema's inferred input type instead of `unknown`.
  - Empty-collection generics default to `Record<string, never>` instead of `Record<string, ...Definition>`, so `keyof` of the default is genuinely empty. Typos in `signalName` / `queryName` / `updateName` on workflows that declare no signals/queries/updates are now compile-time errors.
  - `& string` added to every `TWorkflowName extends keyof TContract["workflows"]` constraint; the compensating `as string` casts at the Temporal-API call sites are gone.

  **New public exports from `@temporal-contract/contract`:**

  - `AnyWorkflowDefinition` — widened-constraint alias used in `Record<string, …>` constraint positions and `T extends WorkflowDefinition` constraints. Lets the narrow `WorkflowDefinition` defaults stay narrow without breaking constraint-position usage.
  - `SignalNamesOf<W>` / `QueryNamesOf<W>` / `UpdateNamesOf<W>` — distributive name-helper types that return `never` when the corresponding field is absent or `undefined` (handles `exactOptionalPropertyTypes`) and distribute correctly over union workflow types.

  **Worker error rename**: `ChildWorkflowCancelledError`'s public field renamed from `childWorkflowName` to `workflowName`, matching the rest of the workflow-error surface (`WorkflowInputValidationError`, `ChildWorkflowNotFoundError`, etc.).

- Updated dependencies [cc6add7]
- Updated dependencies [4401951]
- Updated dependencies [4401951]
  - @temporal-contract/contract@2.1.0

## 2.0.0

### Major Changes

- f95b57c: Replace `@swan-io/boxed` with `neverthrow` across the entire surface.

  The `Future<Result<T, E>>` shape returned by every typed-client method,
  activity implementation, and workflow context helper is now
  `ResultAsync<T, E>` from [`neverthrow`](https://github.com/supermacro/neverthrow).
  The `@temporal-contract/boxed` package has been removed.

  This is a **breaking change** for every downstream consumer. See
  [Migrating to neverthrow](https://btravstack.github.io/temporal-contract/guide/migrating-to-neverthrow)
  for the full mapping. Highlights:

  - Add `neverthrow` to your dependencies; remove `@swan-io/boxed` and
    `@temporal-contract/boxed`.
  - `Result.Ok(v)` → `ok(v)`, `Result.Error(e)` → `err(e)`.
    `Future.value(Result.Ok(v))` → `okAsync(v)`,
    `Future.value(Result.Error(e))` → `errAsync(e)`.
    `Future.fromPromise(p, mapErr)` → `ResultAsync.fromPromise(p, mapErr)`.
  - `.isError()` → `.isErr()`. `.flatMap` / `.flatMapOk` → `.andThen`,
    `.mapError` → `.mapErr`, `.getOr` → `.unwrapOr`,
    `.match({ Ok, Error })` → `.match(okFn, errFn)` (positional).
  - `.tap` / `.tapOk` / `.tapError` have no direct replacement; inline as
    `.map(v => { sideEffect(v); return v })`.

### Patch Changes

- Updated dependencies [f95b57c]
  - @temporal-contract/contract@2.0.0

## 1.0.0

### Major Changes

- 75fa09f: **BREAKING:** Replace `ActivityError` with Temporal's `ApplicationFailure`.

  Closes #121.

  `ActivityError` is gone. Activities now return `Future<Result<Output, ApplicationFailure>>` instead of `Future<Result<Output, ActivityError>>`. `ApplicationFailure` is Temporal's first-class failure shape and gives consumers per-instance `nonRetryable` (closes #121), structured `details`, and the `BENIGN` observability category — all preserved across the activity → workflow serialization boundary that previously flattened our custom class to `ApplicationFailure` anyway.

  `ApplicationFailure` is re-exported from `@temporal-contract/worker/activity` so consumers don't need a separate `@temporalio/common` import:

  ```ts
  import { declareActivitiesHandler, ApplicationFailure } from "@temporal-contract/worker/activity";
  import { Future } from "@swan-io/boxed";

  export const activities = declareActivitiesHandler({
    contract,
    activities: {
      chargePayment: ({ amount }) => {
        return Future.fromPromise(paymentGateway.charge(amount))
          .mapError((error) =>
            ApplicationFailure.create({
              type: "PAYMENT_FAILED",
              message: error instanceof Error ? error.message : "Payment failed",
              // Per-instance non-retryable: Temporal stops retrying immediately.
              nonRetryable: false,
              ...(error instanceof Error ? { cause: error } : {}),
            }),
          )
          .mapOk((tx) => ({ transactionId: tx.id }));
      },
    },
  });
  ```

  ## Migration

  Replace each `new ActivityError(code, message, cause)` with `ApplicationFailure.create({ type: code, message, cause, nonRetryable })`. The third positional `cause` argument moves into the options bag, and the `code` field becomes `type`.

  ```ts
  // Before
  new ActivityError("PAYMENT_FAILED", "Card declined", error);

  // After
  ApplicationFailure.create({
    type: "PAYMENT_FAILED",
    message: "Card declined",
    cause: error instanceof Error ? error : undefined,
  });
  ```

  `@temporalio/common` is added as a peer dependency for the `ApplicationFailure` re-export.

### Minor Changes

- 58fb9cd: Close part of the API gap with `@swan-io/boxed`, document the rest.

  Closes #186.

  ## New `Result` methods
  - `result.tap(fn)` — run a side effect with the Ok value, return the Result unchanged. No-op on Err.
  - `result.tapError(fn)` — run a side effect with the Err value, return the Result unchanged. No-op on Ok.
  - `result.flatMapError(fn)` — Err-path equivalent of `flatMap`. Useful for recovery and error-type transformations.
  - `Result.allFromDict({...})` — combine a record of Results into a Result of a record. First Err wins.

  All four match the corresponding `@swan-io/boxed` semantics.

  ## New docs page

  `docs/guide/boxed-vs-swan.md` enumerates the full `Result` and `Future` surface for both libraries side-by-side, calls out each gap with its reason (determinism, soundness regression, not-yet-ported), establishes `match` / `isOk` / `isError` as the canonical discriminants (with `tag` documented as the power-user escape hatch), and includes a migration cheat sheet. The package README links it; the existing `result-pattern.md` "Both packages provide the same API" claim has been corrected.

  ## Still intentionally absent
  - `Result#getWithDefault` — duplicate of `getOr`; removed in 0.x.
  - `Result#toOption`, `okToOption`, `errorToOption`, `Option` type — `Option` was removed when nothing in the codebase consumed it. Use `result.match({ Ok: (v) => v, Error: () => undefined })`.
  - `Result.fromExecution<T, E>(fn)` typed-error overload — was unsound (`error as E` cast without runtime guard). The un-narrowed `Result<T, unknown>` form is preserved; narrow at the call site via `.mapError`.
  - `Future.concurrent` and `Future.mapOkToResult` — useful but not blocking; ports welcome.

- d70f25e: `declareWorkflow` accepts a new optional `activityOptionsByName` field for
  per-activity `ActivityOptions` overrides.

  Closes #122.

  Today, `activityOptions` applies to every activity reachable from the
  workflow. `activityOptionsByName` lets you override timeouts, retry policy,
  or any other Temporal `ActivityOptions` field for individual activities:

  ```ts
  declareWorkflow({
    workflowName: "processOrder",
    contract,
    activityOptions: {
      startToCloseTimeout: "1 minute", // default for all activities
    },
    activityOptionsByName: {
      // Payment gateway is slow — give it room and retry aggressively.
      chargePayment: {
        startToCloseTimeout: "5 minutes",
        retry: { maximumAttempts: 5 },
      },
      // Cheap CPU-bound check — fail fast if it stalls.
      validateOrder: { startToCloseTimeout: "5 seconds" },
    },
    implementation: ...,
  });
  ```

  Each entry shallow-merges over the workflow default. The override wins on
  every property it specifies, including the entire nested `retry` block —
  this matches Temporal's "one `ActivityOptions` per `proxyActivities` call"
  semantics, where each scheduled activity carries one full options bag.

  Activity names are typed against the contract (workflow-local + global), so
  typos surface at compile time rather than running silently with the default
  options.

  Non-breaking: existing workflows that only use `activityOptions` are
  unchanged.

- ad1e1da: Round-2 review-driven cleanup. Several small breaking removals, a typed-error overload on `Future.fromPromise`, and a deduplication of the client's typed-handle proxies.

  **Breaking changes (`@temporal-contract/boxed`)**

  - Removed `getWithDefault` from `Result`. It was a literal duplicate of `getOr`. Migrate by using `getOr(...)` everywhere.
  - Removed the half-implemented `Option` type and the `Result#toOption()` method. They had no constructors, no methods, and no consumer in the codebase. If you need optionality, use `T | undefined`.
  - `Result.fromExecution` and `Result.fromAsyncExecution` now return `Result<T, unknown>` (the second `E` generic is gone). The previous signature accepted an `E` generic but cast `error as E` without any runtime guard, which was unsound. Narrow at the call site: `Result.fromExecution(...).mapError((e) => mapToYourError(e))`.

  **Breaking changes (`@temporal-contract/worker`)**

  - Removed the `getWorkflowActivities`, `getWorkflowActivityNames`, `isWorkflowActivity`, and `getWorkflowNames` helpers from `@temporal-contract/worker/activity`. They had no internal usage, no example usage, and `isWorkflowActivity` was misnamed (returned true for global activities). If you depended on them, derive equivalents directly from the contract — but **remember the merge with global activities**:

    ```ts
    // Before:
    const activities = getWorkflowActivities(contract, "processOrder");
    const names = getWorkflowActivityNames(contract, "processOrder");
    const isAvailable = isWorkflowActivity(contract, "processOrder", "send");
    const workflows = getWorkflowNames(contract);

    // After:
    const activities = {
      ...(contract.activities ?? {}),
      ...(contract.workflows.processOrder.activities ?? {}),
    };
    const names = Object.keys(activities);
    const isAvailable = "send" in activities;
    const workflows = Object.keys(contract.workflows);
    ```

    `contract.workflows[name].activities` alone only contains workflow-local activities; you must merge `contract.activities` to match the old helper's behavior.

  **Breaking changes (`@temporal-contract/client`)**

  - The internal proxy generation was deduplicated. The shape and types of `TypedWorkflowHandle.queries`/`signals`/`updates` are unchanged.
  - `RuntimeClientError` is now exported. Match against it with `instanceof RuntimeClientError` or ts-pattern's `P.instanceOf(RuntimeClientError)`.

  **Additions**

  - `Future.fromPromise` (`@temporal-contract/boxed`) accepts an optional `mapError` argument that lifts the error type at the boundary instead of stripping to `unknown`. Existing call sites without the second argument are unchanged.
  - `defineQuery`'s JSDoc now calls out the synchronous-validator constraint (Temporal queries must complete synchronously, so async refinements aren't supported).
  - New tests: typed-error `Future.fromPromise` overload coverage, swan-boxed round-trip preservation, deterministic-replay assertions for `Future` chains, negative type-level assertion for the worker/client `InferInput`/`InferOutput` duality.

  **Internal**

  - Hoisted the `args.length === 1 ? args[0] : args` heuristic into a single `extractHandlerInput` helper used across activity, workflow, signal, query, and update handlers.
  - Dropped runtime defensive checks in `defineSignal`/`defineQuery`/`defineUpdate` that the type system already prevents.
  - Activity and workflow entry points now carry a top-of-file comment explaining the swan-vs-local Result/Future split.
  - `Future.then` / `catch` / `finally` JSDoc clarifies they return raw `Promise`s and break Future chainability.

- 5948e4e: Add `TypedClient#signalWithStart` for the actor-style "send a signal, start the workflow if it doesn't exist" pattern.

  Closes #178.

  Both halves of the call are typed against the contract: workflow input validates against `contract.workflows[name].input`, signal input validates against `contract.workflows[name].signals[signalName].input`. Returns a `TypedWorkflowHandleWithSignaledRunId` — the standard typed handle plus a `signaledRunId` field for correlating the signal with the (possibly pre-existing) workflow execution chain.

  ```ts
  const result = await client.signalWithStart("processOrder", {
    workflowId: "order-123",
    args: { orderId: "ORD-123", customerId: "CUST-1" },     // typed against workflow input
    signalName: "cancel",                                     // restricted to declared signals
    signalArgs: { reason: "duplicate" },                      // typed against signal input
  });

  result.match({
    Ok: (handle) => console.log("signaled run", handle.signaledRunId),
    Error: (error) => /* WorkflowNotFoundError | WorkflowValidationError | SignalValidationError | RuntimeClientError */,
  });
  ```

- ef7427d: Add typed cancellation-scope helpers to the workflow context.

  Closes #183.

  ## What ships

  Two new methods on the `WorkflowContext` passed to `declareWorkflow`'s `implementation`:

  ```ts
  context.cancellableScope<T>(fn): Future<Result<T, WorkflowCancelledError>>
  context.nonCancellableScope<T>(fn): Future<Result<T, WorkflowCancelledError>>
  ```

  Both wrap Temporal's `CancellationScope.cancellable` / `.nonCancellable` so workflows can opt into fine-grained cancellation control without reaching for `@temporalio/workflow` directly. Cancellation surfaces as `Result.Error(WorkflowCancelledError)` instead of a thrown `CancelledFailure`, so call sites can branch on cancellation explicitly. The shape mirrors `context.startChildWorkflow` / `context.executeChildWorkflow`; the rest of the context API (activity proxies, `continueAsNew`) keeps its existing `Promise`-based shape.

  ```ts
  declareWorkflow({
    workflowName: "processOrder",
    contract,
    implementation: async (context, args) => {
      const result = await context.cancellableScope(async () => {
        return context.activities.processStep(args);
      });

      if (result.isError()) {
        // Graceful exit: perform cleanup that must not be cancelled.
        await context.nonCancellableScope(async () => {
          await context.activities.releaseResources(args);
        });
        return { status: "cancelled" };
      }

      return { status: "ok" };
    },
  });
  ```

  Non-cancellation errors thrown inside the scope are _not_ swallowed — the Future rejects with the original error, preserving its identity for upstream `try/catch` blocks.

  The new `WorkflowCancelledError` class is re-exported from `@temporal-contract/worker/workflow` alongside the existing validation errors.

- 80c822b: Add typed `context.continueAsNew(...)` to the workflow context.

  Closes #179.

  Two overloads:

  ```ts
  // Same workflow — args validated against this workflow's input schema
  return context.continueAsNew({ ...args, retryCount: args.retryCount + 1 });

  // Cross-contract — workflowType and taskQueue come from the destination
  // contract automatically; args validated against the destination's input
  return context.continueAsNew(otherContract, "otherWorkflow", { ...newArgs });
  ```

  Both validate args via the same Standard Schema check `declareWorkflow` runs on incoming inputs. On validation failure, throws `WorkflowInputValidationError`, which surfaces back to Temporal as a controlled workflow failure rather than silently proceeding with an invalid run.

  Both forms also accept a third optional argument matching Temporal's `ContinueAsNewOptions` minus `workflowType` / `taskQueue` (those come from the contract). The user options are spread last so power users can override fields like `workflowRunTimeout`, `memo`, or `retry`.

  Returns `Promise<never>` — Temporal's `continueAsNew` throws an internal exception that the runtime intercepts to terminate the current execution and start a new one.

- 26ab350: Add typed Schedules to `TypedClient` (Temporal 1.16+).

  Closes #181.

  ```ts
  const result = await client.schedule.create("processOrder", {
    scheduleId: "daily-sweep",
    spec: { cronExpressions: ["0 2 * * *"] },
    args: { orderId: "sweep" },        // typed against the workflow's input
    policies: { overlap: "SKIP" },
    workflowExecutionTimeout: "1 hour",
  });

  result.match({
    Ok: async (handle) => {
      await handle.pause("maintenance");
      await handle.unpause();
      await handle.trigger();
      await handle.delete();
    },
    Error: (error) => /* WorkflowNotFoundError | WorkflowValidationError | RuntimeClientError */,
  });

  // Existing schedule:
  const handle = client.schedule.getHandle("daily-sweep");
  const desc = await handle.describe();
  ```

  ## What ships
  - `client.schedule.create(workflowName, options)` — validates `args` against the workflow's input schema, then calls Temporal's `client.schedule.create` with `workflowType` and `taskQueue` derived from the contract. Returns `Future<Result<TypedScheduleHandle, ...>>`.
  - `client.schedule.getHandle(scheduleId)` — lifts an existing schedule handle into the typed wrapper.
  - `TypedScheduleHandle` exposes `pause`, `unpause`, `trigger`, `delete`, `describe`, all wrapped in the Future/Result pattern (`Future<Result<void | ScheduleDescription, RuntimeClientError>>`).

  ## Scope (v1)
  - Action type is **`startWorkflow` only**, matching the issue's stated v1 scope. Other Temporal action kinds aren't part of this PR.
  - Schedule-level Temporal options forwarded: `policies`, `state`, `memo`, plus workflow-action–level overrides (`workflowId`, retry, timeouts, memo, etc.). `workflowType` and `taskQueue` are owned by the contract.
  - The client's `schedule` field exposes a `TypedScheduleClient` instance that wraps Temporal's `Client.schedule` (mirroring how Temporal's API is organized).

  ## Out of scope
  - Schedule lifecycle methods that don't have an obvious typed boundary (`update`, `backfill`, `readme`) — Temporal's raw types still apply; consumers can drop down to the underlying handle if needed.
  - Search-attribute integration on the schedule itself — that follows after #180 ships and the worker-side typed reader lands.

- 5614348: Add typed search attributes to the contract surface.

  Closes #180.

  ## What ships

  **Contract** — declare attribute kinds alongside signals/queries/updates:

  ```ts
  import {
    defineContract,
    defineSearchAttribute,
    defineWorkflow,
  } from "@temporal-contract/contract";

  defineContract({
    taskQueue: "orders",
    workflows: {
      processOrder: defineWorkflow({
        input: z.object({ orderId: z.string() }),
        output: z.object({ status: z.string() }),
        searchAttributes: {
          customerId: defineSearchAttribute({ kind: "KEYWORD" }),
          priority: defineSearchAttribute({ kind: "INT" }),
          placedAt: defineSearchAttribute({ kind: "DATETIME" }),
          tags: defineSearchAttribute({ kind: "KEYWORD_LIST" }),
          urgent: defineSearchAttribute({ kind: "BOOL" }),
        },
      }),
    },
  });
  ```

  The seven Temporal kinds (`TEXT`, `KEYWORD`, `INT`, `DOUBLE`, `BOOL`, `DATETIME`, `KEYWORD_LIST`) map to TypeScript types via the new `SearchAttributeKindToType<K>` utility.

  **Client** — `searchAttributes` becomes a typed parameter on `startWorkflow` and `executeWorkflow`. Keys are constrained to declared attributes, value types follow each attribute's `kind`:

  ```ts
  await client.startWorkflow("processOrder", {
    workflowId: "order-1",
    args: { orderId: "ORD-1" },
    searchAttributes: {
      customerId: "CUST-1", // string (KEYWORD)
      priority: 3, // number (INT)
      placedAt: new Date(), // Date (DATETIME)
      tags: ["vip", "urgent"], // string[] (KEYWORD_LIST)
      urgent: true, // boolean (BOOL)
    },
  });
  ```

  The client translates the typed map into a Temporal `TypedSearchAttributes` instance before dispatching the start request.

  **Validation** — `defineContract` validates that each search-attribute name is a JS identifier and that each `kind` is one of the seven supported values.

  ## New peer dep

  `@temporal-contract/client` adds `@temporalio/common` as a peer dependency (alongside the existing `@temporalio/client` peer) for the `TypedSearchAttributes` import.

  ## Deferred

  The worker-side typed reader (`context.searchAttributes.get("customerId")`) is not in this PR. Workers can still read via Temporal's `workflowInfo().typedSearchAttributes`, and the contract-declared attribute kinds make it straightforward to wrap that in a typed accessor in a follow-up.

### Patch Changes

- e9974c3: Hoist `defineSignal` / `defineQuery` / `defineUpdate` helpers out of `declareWorkflow`'s closure.

  Closes #185.

  Internal refactor — no behavior change. The three helpers that bind contract-validated signal / query / update handlers to a running workflow are now top-level functions in a new `handlers.ts` module instead of nested closures inside `declareWorkflow`. Their bodies (≈130 LoC) are no longer reallocated on each workflow invocation, and `workflow.ts` shrinks from ~870 to ~720 LoC.

  The typed call-site surface is preserved: `context.defineSignal/Query/Update` still carry their `K extends keyof TContract["workflows"][TWorkflowName]["signals" | "queries" | "updates"]` constraints, the runtime guards against missing-block / unknown-name still fire with the same messages, and the query helper still rejects async-validating schemas (Temporal's queries must be synchronous).

  Three handler-implementation type aliases (`SignalHandlerImplementation`, `QueryHandlerImplementation`, `UpdateHandlerImplementation`) move alongside the bind helpers since they belong with the handler concept rather than the entry point.

- db7ea8b: Review-driven cleanup across packages.

  - **`@temporal-contract/worker`**: remove `main`/`module`/`types` fields from `package.json` that pointed to non-existent `dist/index.*` files; the package is consumed via the `./activity`, `./worker`, `./workflow` subpath exports only.
  - **`@temporal-contract/contract`**: `defineContract` now also rejects two workflows declaring activities with the same name. Activities live in a single flat namespace at runtime, so duplicates were silently clobbering each other before.
  - **`@temporal-contract/client`**: validation error messages (`WorkflowValidationError`, `QueryValidationError`, `SignalValidationError`, `UpdateValidationError`) now join issue messages with `; ` instead of `JSON.stringify`-ing the entire issue array. The `issues` array remains accessible as a typed property.
  - **`@temporal-contract/testing`**: import `NativeConnection` from the public `@temporalio/worker` entry point instead of the deep `@temporalio/worker/lib/connection.js` path.
  - **`@temporal-contract/worker`**: hoisted the child-workflow helpers out of `declareWorkflow`'s closure to module scope. No behavior change.

- fd60d73: Validation error messages now include the failing field's path.

  Closes #141.

  Standard Schema's `Issue` type carries a `path` (e.g. `["items", 0, "quantity"]`) but our error formatting was joining only `issue.message`, dropping the path. With nested input shapes you'd get unhelpful messages like:

  ```
  Activity "matchItemsChunk" input validation failed:
    Invalid input: expected array, received undefined;
    Invalid input: expected number, received undefined
  ```

  You now get:

  ```
  Activity "matchItemsChunk" input validation failed:
    at items: Invalid input: expected array, received undefined;
    at items[0].quantity: Invalid input: expected number, received undefined
  ```

  The format is dot+bracket notation (familiar to JS devs): top-level string keys appear bare, nested string keys with leading `.`, numeric keys as `[N]`. `PathSegment`-form path entries (the spec's alternative shape) and symbol keys are handled too.

  Affects every validation error class in `@temporal-contract/worker` (activity input/output, workflow input/output, signal input, query input/output, update input/output) and `@temporal-contract/client` (workflow / query / signal / update validation errors). Child-workflow input/output validation messages in workflow.ts are also path-aware now.

  The `issues` property on each error class is unchanged — programmatic consumers who walk `error.issues` and format their own output are unaffected.

- Updated dependencies [58fb9cd]
- Updated dependencies [d70f25e]
- Updated dependencies [ad1e1da]
- Updated dependencies [db7ea8b]
- Updated dependencies [5948e4e]
- Updated dependencies [80c822b]
- Updated dependencies [26ab350]
- Updated dependencies [5614348]
- Updated dependencies [fd60d73]
  - @temporal-contract/boxed@1.0.0
  - @temporal-contract/contract@1.0.0

## 0.2.0

### Minor Changes

- Align project structure with amqp-contract and address code quality issues across packages.

### Patch Changes

- Updated dependencies
  - @temporal-contract/contract@0.2.0
  - @temporal-contract/boxed@0.2.0

## 0.1.0

### Minor Changes

- ## Breaking Changes
  - Removed unimplemented Nexus types from public API (`defineNexusOperation`, `defineNexusService`, and related types). These were proof-of-concept exports that were not yet functional. The planned Nexus API design is documented at https://btravstack.github.io/temporal-contract/guide/nexus-integration

  ## Improvements

  ### Documentation
  - Enhanced documentation site with comprehensive SEO (meta tags, JSON-LD structured data, sitemap, canonical URLs)
  - Added "Why temporal-contract?" guide explaining the value proposition
  - Added "Troubleshooting" guide with common issues and solutions
  - Simplified homepage with cleaner feature presentation and quick example
  - Reorganized sidebar navigation to match industry patterns

  ### Package Fixes
  - **@temporal-contract/worker-nestjs**: Updated peer dependencies from NestJS ^10 to ^11 for consistency with client-nestjs
  - **@temporal-contract/worker-nestjs**: Changed hardcoded dependency versions to use pnpm catalog references

### Patch Changes

- Updated dependencies
  - @temporal-contract/contract@0.1.0
  - @temporal-contract/boxed@0.1.0

## 0.0.7

### Patch Changes

- Replace @temporal-contract/boxed with @swan-io/boxed in client and activities. The @temporal-contract/boxed package now focuses on Temporal-compatible implementations for workflows while @swan-io/boxed is used for client-side and activity code.
- Updated dependencies
  - @temporal-contract/boxed@0.0.7
  - @temporal-contract/contract@0.0.7

## 0.0.6

### Patch Changes

- Release version 0.0.6
- Updated dependencies
  - @temporal-contract/contract@0.0.6
  - @temporal-contract/boxed@0.0.6

## 0.0.5

### Patch Changes

- Release version 0.0.5 - Add @temporal-contract/boxed to releases
- Updated dependencies
  - @temporal-contract/contract@0.0.5
  - @temporal-contract/boxed@0.0.5

## 0.0.4

### Patch Changes

- Merge client and worker boxed implementations
- Updated dependencies
  - @temporal-contract/contract@0.0.4

## 0.0.3

### Patch Changes

- Release version 0.0.3
- Updated dependencies
  - @temporal-contract/contract@0.0.3

## 0.0.2

### Patch Changes

- Release version 0.0.2
- Updated dependencies
  - @temporal-contract/contract@0.0.2
