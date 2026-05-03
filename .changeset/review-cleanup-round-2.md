---
"@temporal-contract/contract": minor
"@temporal-contract/worker": minor
"@temporal-contract/client": minor
"@temporal-contract/boxed": minor
"@temporal-contract/testing": minor
---

Round-2 review-driven cleanup. Several small breaking removals, a typed-error overload on `Future.fromPromise`, and a deduplication of the client's typed-handle proxies.

**Breaking changes (`@temporal-contract/boxed`)**

- Removed `getWithDefault` from `Result`. It was a literal duplicate of `getOr`. Migrate by using `getOr(...)` everywhere.
- Removed the half-implemented `Option` type and the `Result#toOption()` method. They had no constructors, no methods, and no consumer in the codebase. If you need optionality, use `T | undefined`.
- `Result.fromExecution` and `Result.fromAsyncExecution` now return `Result<T, unknown>` (the second `E` generic is gone). The previous signature accepted an `E` generic but cast `error as E` without any runtime guard, which was unsound. Narrow at the call site: `Result.fromExecution(...).mapError((e) => mapToYourError(e))`.

**Breaking changes (`@temporal-contract/worker`)**

- Removed the `getWorkflowActivities`, `getWorkflowActivityNames`, `isWorkflowActivity`, and `getWorkflowNames` helpers from `@temporal-contract/worker/activity`. They had no internal usage, no example usage, and `isWorkflowActivity` was misnamed (returned true for global activities). If you depended on them, derive equivalents directly from the contract object — `Object.keys(contract.workflows)`, `contract.workflows[name].activities`, etc.

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
