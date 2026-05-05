# @temporal-contract/worker

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
  [Migrating to neverthrow](https://btravers.github.io/temporal-contract/guide/migrating-to-neverthrow)
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
  - Removed unimplemented Nexus types from public API (`defineNexusOperation`, `defineNexusService`, and related types). These were proof-of-concept exports that were not yet functional. The planned Nexus API design is documented at https://btravers.github.io/temporal-contract/guide/nexus-integration

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
