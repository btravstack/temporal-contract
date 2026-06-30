# @temporal-contract/client

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

### Patch Changes

- Updated dependencies [eae7aae]
  - @temporal-contract/contract@2.4.0

## 2.3.1

### Patch Changes

- 9c865cc: Loosen the `@temporalio/client` peer dependency range from `^1.16.0` back to `^1`.

  The `^1.16.0` floor was set because `client.schedule` (the Schedule API) only exists in `@temporalio/client` 1.16+. But `TypedClient`'s constructor already fails fast with a clear ">= 1.16" error if a consumer reaches for the Schedule API on an older version, so the stricter install-time range was redundant. Widening it back to `^1` keeps the package permissive about the installed Temporal version — consumers on 1.0–1.15 who never touch schedules no longer get a spurious peer-dependency warning — while the runtime guard still protects anyone who does. This also realigns the client peer range with `@temporalio/common` (`^1`) and the worker package.

  - @temporal-contract/contract@2.3.1

## 2.3.0

### Minor Changes

- 12b860e: Bump runtime dependencies: `testcontainers` 11 → 12 and `@temporalio/*` 1.17 → 1.18 in `@temporal-contract/testing`. Peer ranges (`@temporalio/*` `^1`, `neverthrow` `^8`) are unchanged.

### Patch Changes

- Updated dependencies [12b860e]
  - @temporal-contract/contract@2.3.0

## 2.2.0

### Minor Changes

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

### Patch Changes

- 45bd7ee: Closes the remaining audit items: documents the activity input/output shape asymmetry, replaces the example `log` Temporal activity with `@temporalio/workflow`'s `log` namespace, and converts test assertions from `expect.objectContaining({ name: "...Error" })` to `toBeInstanceOf(...)` across worker / client / example specs.

  **Audit #15 — example `log` Temporal activity is a footgun.** Calling an activity per log line balloons workflow history, costs money on Temporal Cloud, and replays on every recovery. The example contract no longer declares a `log` activity; the example workflow imports `log` from `@temporalio/workflow` (replay-safe, routed through the worker's configured logger sink) and calls `log.info(...)` / `log.error(...)` / `log.warn(...)` directly. Domain effects still go through activities. Removed the unused `inventoryReservationId` variable while in there.

  **Audit #16 — test assertions on internal shape rather than error class.** Eight sites across `worker/__tests__/worker.spec.ts`, `worker/activity.spec.ts`, `worker/continue-as-new.spec.ts`, `client/__tests__/client.spec.ts`, and the order-processing example's `integration.spec.ts` were asserting on `name: "...Error"` strings instead of the actual error classes. Switched to `toBeInstanceOf(...)`, which catches subclass renames at compile time and matches the contract-not-implementation rule the codebase aspires to.

  **Audit #10 — activity input/output shape asymmetry.** Documented in the JSDoc on `ContractResultActivitiesImplementations` and `ActivitiesHandler`. The asymmetry is intentional and worth keeping: the input you write mirrors the contract's structure (global at root + workflow-local nested under their owning workflow), giving IDE autocomplete that matches `defineContract`; the output is flat because Temporal's worker sees a single namespace at runtime. `defineContract` already enforces no-collisions across global+workflow scopes, so the flat output has no ambiguity.

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

- dfedc5d: Discriminate Temporal client errors as typed `Result.Error` variants.

  Closes #184.

  ## What ships

  Three new error classes are surfaced from `@temporal-contract/client`, each catching a specific Temporal SDK error class and exposing it through the existing `Future<Result<...>>` shape so callers can branch on it without inspecting `error.cause` against `@temporalio/client` internals.

  | Error class                      | Caught Temporal class                  | Surfaced from                                                                                                                         |
  | -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
  | `WorkflowAlreadyStartedError`    | `WorkflowExecutionAlreadyStartedError` | `startWorkflow`, `signalWithStart`, `executeWorkflow`                                                                                 |
  | `WorkflowExecutionNotFoundError` | `WorkflowNotFoundError` (Temporal)     | handle methods (`signal`, `query`, `executeUpdate`, `terminate`, `cancel`, `describe`, `fetchHistory`), `executeWorkflow`, `result()` |
  | `WorkflowFailedError`            | `WorkflowFailedError` (Temporal)       | `executeWorkflow`, `result()`                                                                                                         |

  ```ts
  const result = await client.startWorkflow("processOrder", {
    workflowId: "order-1",
    args: { orderId: "ORD-1" },
  });

  result.match({
    Ok: (handle) => /* ... */,
    Error: (e) => {
      if (e instanceof WorkflowAlreadyStartedError) {
        // idempotent: re-fetch the existing handle and continue
      }
      // ...
    },
  });
  ```

  ## Naming

  `WorkflowExecutionNotFoundError` is named differently from the existing `WorkflowNotFoundError` (which signals a workflow not declared in the contract — a static contract check) so the two cases stay distinguishable. The Temporal-runtime variant takes the `Execution` qualifier to mirror Temporal's `WorkflowExecution*` server-side concepts.

  ## Backwards compatibility

  The new error classes extend the existing union; previously these would surface as `RuntimeClientError`, which still catches every other thrown error. Existing `instanceof RuntimeClientError` checks continue to work for unrelated failures, but won't match the new discriminated variants — this is the point.

### Patch Changes

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
  - @temporal-contract/contract@1.0.0

## 0.2.0

### Minor Changes

- Align project structure with amqp-contract and address code quality issues across packages.

### Patch Changes

- Updated dependencies
  - @temporal-contract/contract@0.2.0

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

## 0.0.7

### Patch Changes

- Replace @temporal-contract/boxed with @swan-io/boxed in client and activities. The @temporal-contract/boxed package now focuses on Temporal-compatible implementations for workflows while @swan-io/boxed is used for client-side and activity code.
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
