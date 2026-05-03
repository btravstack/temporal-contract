---
title: "@temporal-contract/boxed vs @swan-io/boxed"
description: API surface and intentional differences between temporal-contract's deterministic-replay-safe Result/Future implementation and the upstream @swan-io/boxed library.
---

# `@temporal-contract/boxed` vs `@swan-io/boxed`

`@temporal-contract/boxed` ships its own `Result` and `Future` because workflow code runs inside Temporal's deterministic-replay sandbox — every API surface a workflow touches must be intercept-aware. `@swan-io/boxed`, the inspiration, is excellent for activities and client code but reaches for primitives (e.g. `setImmediate`, native `Promise.race` semantics) that interact poorly with replay.

This page documents which `@swan-io/boxed` API made it into the local copy, which didn't, and why. **The two libraries are intentionally not 1:1 drop-ins.** When you copy a swan snippet into workflow code, check this page first.

::: tip Where to use which
**Workflows** must use `@temporal-contract/boxed`. **Activities, clients, and any non-workflow code** can use either, but we standardize on `@swan-io/boxed` for its richer surface.
:::

## Choosing a discriminant

Each `Result` value is either an `Ok` or an `Err`. The library exposes three equivalent ways to discriminate them; pick the one that fits your call site:

| Style       | Example                                           | When to use                                                         |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| `match`     | `result.match({ Ok: (v) => …, Error: (e) => … })` | Most readable for non-trivial branches; exhaustive by construction. |
| Type guards | `if (result.isOk()) { … } else { … }`             | When one branch wants control flow (early return, throw, etc.).     |
| Tag check   | `if (result.tag === "Ok") { … }`                  | Power-user / pattern-matching libraries (e.g. ts-pattern).          |

The `tag` field (`"Ok"` / `"Error"`) is part of the public API but isn't used in the documented examples — it's there for ts-pattern interop and for narrowing in deeply destructured contexts. If you're not sure which to use, default to `match`.

## `Result` API surface

| Method / Function                          | swan | local | Notes                                                                                                                                            |
| ------------------------------------------ | :--: | :---: | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Result.Ok(v)`                             |  ✅  |  ✅   |                                                                                                                                                  |
| `Result.Error(e)`                          |  ✅  |  ✅   |                                                                                                                                                  |
| `Result.isOk(r)` / `Result.isError(r)`     |  ✅  |  ✅   |                                                                                                                                                  |
| `Result.all(results[])`                    |  ✅  |  ✅   | First Err wins.                                                                                                                                  |
| `Result.allFromDict({...})`                |  ✅  |  ✅   | Iteration order matches `Object.entries`.                                                                                                        |
| `Result.fromExecution(fn)`                 |  ✅  |  ✅   | Returns `Result<T, unknown>` — narrow via `.mapError`.                                                                                           |
| `Result.fromAsyncExecution(fn)`            |  ✅  |  ✅   |                                                                                                                                                  |
| `Result.fromExecution<T, E>(fn)` (typed E) |  ✅  |  ❌   | Removed in `@temporal-contract/boxed` because it cast `error as E` without a runtime guard, mistyping the error variant.                         |
| `result.map(fn)`                           |  ✅  |  ✅   |                                                                                                                                                  |
| `result.mapError(fn)`                      |  ✅  |  ✅   |                                                                                                                                                  |
| `result.flatMap(fn)`                       |  ✅  |  ✅   |                                                                                                                                                  |
| `result.flatMapOk(fn)`                     |  ✅  |  ✅   | Alias of `flatMap`.                                                                                                                              |
| `result.flatMapError(fn)`                  |  ✅  |  ✅   | Recovery / Err-path chaining.                                                                                                                    |
| `result.tap(fn)`                           |  ✅  |  ✅   | Side effect on Ok.                                                                                                                               |
| `result.tapError(fn)`                      |  ✅  |  ✅   | Side effect on Err.                                                                                                                              |
| `result.match({ Ok, Error })`              |  ✅  |  ✅   |                                                                                                                                                  |
| `result.getOr(default)`                    |  ✅  |  ✅   |                                                                                                                                                  |
| `result.getWithDefault(default)`           |  ✅  |  ❌   | Removed in 0.x — `getOr` is the canonical name.                                                                                                  |
| `result.toOption()` / `Option` type        |  ✅  |  ❌   | `Option` was removed when no consumer was using it. Use `result.match({ Ok: (v) => v, Error: () => undefined })` if you need a `T \| undefined`. |
| `result.okToOption()` / `errorToOption()`  |  ✅  |  ❌   | Same — Option-related.                                                                                                                           |
| `result.isOk()` / `result.isError()`       |  ✅  |  ✅   |                                                                                                                                                  |
| `result.tag` (`"Ok"` / `"Error"`)          |  ✅  |  ✅   |                                                                                                                                                  |

## `Future` API surface

| Method / Function                       | swan | local | Notes                                                                              |
| --------------------------------------- | :--: | :---: | ---------------------------------------------------------------------------------- |
| `Future.value(v)`                       |  ✅  |  ✅   |                                                                                    |
| `Future.make(executor)`                 |  ✅  |  ✅   |                                                                                    |
| `Future.fromPromise(promise)`           |  ✅  |  ✅   | Returns `Future<Result<T, unknown>>`.                                              |
| `Future.fromPromise(promise, mapError)` |  ❌  |  ✅   | **Local extension** — lifts the error type at the boundary.                        |
| `Future.fromAsync(fn)`                  |  ✅  |  ✅   |                                                                                    |
| `Future.reject(error)`                  |  ✅  |  ✅   |                                                                                    |
| `Future.all(futures[])`                 |  ✅  |  ✅   |                                                                                    |
| `Future.race(futures[])`                |  ✅  |  ✅   |                                                                                    |
| `Future.concurrent(...)`                |  ✅  |  ❌   | Controlled-parallelism helper. Not yet ported — open a discussion if you need it.  |
| `future.map(fn)`                        |  ✅  |  ✅   |                                                                                    |
| `future.flatMap(fn)`                    |  ✅  |  ✅   |                                                                                    |
| `future.mapOk(fn)`                      |  ✅  |  ✅   | Map over `Future<Result>`.                                                         |
| `future.mapError(fn)`                   |  ✅  |  ✅   |                                                                                    |
| `future.flatMapOk(fn)`                  |  ✅  |  ✅   |                                                                                    |
| `future.mapOkToResult(fn)`              |  ✅  |  ❌   | Use `mapOk(fn)` then narrow, or `flatMapOk((v) => Future.value(fn(v)))`.           |
| `future.tap(fn)` / `tapOk` / `tapError` |  ✅  |  ✅   |                                                                                    |
| `future.toPromise()`                    |  ✅  |  ✅   |                                                                                    |
| `future.then` / `catch` / `finally`     |  ✅  |  ✅   | Returns raw `Promise`, **not** `Future`. Use `.map` / `.flatMap` to keep chaining. |

## Interop helpers

`@temporal-contract/boxed/interop` exports converters between the two implementations for codebases that mix activity (swan) and workflow (local) code:

```ts
import {
  fromSwanResult,
  toSwanResult,
  fromSwanFuture,
  toSwanFuture,
} from "@temporal-contract/boxed/interop";
```

Round-trip preservation is unit-tested for both `Result` and `Future<Result>` shapes.

## Why the gap exists

Three categories explain every absent method:

1. **Determinism-incompatible.** A method that reads non-deterministic primitives (the system clock, a real RNG, the platform scheduler) can't ship in workflow code. Workflows replay, and replays must be byte-identical.
2. **Soundness regression in the upstream API.** `Result.fromExecution<T, E>(fn)` cast unknown thrown values to `E` without a runtime guard — running with stringified errors that swore they were a custom domain class. Removed and replaced with the un-narrowed `Result<T, unknown>` form, narrow via `.mapError`.
3. **Not yet ported.** `Future.concurrent`, `Future.mapOkToResult` — useful but not blocking anyone yet. Open a discussion on the repo if you hit a hole.

## Migration cheat sheet

If you've been writing against `@swan-io/boxed` and are now porting to a workflow:

```diff
- import { Future, Result } from "@swan-io/boxed";
+ import { Future, Result } from "@temporal-contract/boxed";

- const handle = result.toOption();
+ const handle = result.match({ Ok: (v) => v, Error: () => undefined });

- const value = result.getWithDefault(0);
+ const value = result.getOr(0);

- const r = Result.fromExecution<number, MyError>(() => parse(x));
+ const r = Result.fromExecution(() => parse(x))
+   .mapError((e) => new MyError(String(e)));
```

Most of your code won't need to change.
