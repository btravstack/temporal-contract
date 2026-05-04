# Migrating from @swan-io/boxed to neverthrow

`temporal-contract` previously used `@swan-io/boxed` for its `Result`/`Future`
pattern. Starting in this major version it uses [`neverthrow`] instead — the
shape of the API surface is the same (signals/queries/updates/activities all
return a `Result`-like value), but the names and instance methods are
different.

This page is an end-to-end mapping for upgrading existing code.

[`neverthrow`]: https://github.com/supermacro/neverthrow

## Why the change

- **Ecosystem**: `neverthrow` is the most widely-used Result library on npm
  and is a more familiar API for new contributors.
- **Bundle size**: `neverthrow` ships smaller bundles and avoids the custom
  `Future` class — neverthrow's `ResultAsync` covers the same use cases.
- **Maintenance**: `@swan-io/boxed` had a critical issue affecting our usage
  that prompted the move.

## Drop the dep, add the new one

```diff
  // package.json
  "dependencies": {
-   "@swan-io/boxed": "^3"
+   "neverthrow": "^8"
  }
```

If you used `@temporal-contract/boxed`, that package no longer exists — its
exports are gone and replaced by `neverthrow` types. Remove every import.

```diff
- import { Future, Result } from "@swan-io/boxed";
- import { Future, Result } from "@temporal-contract/boxed";
+ import { ResultAsync, ok, err, okAsync, errAsync } from "neverthrow";
```

## Type signatures

Every `Future<Result<T, E>>` becomes `ResultAsync<T, E>`. Bare `Future<T>` (no
`Result`) is not used anywhere in the public surface, so the migration is a
1-for-1 rename.

```diff
- (args: TInput): Future<Result<TOutput, MyError>>
+ (args: TInput): ResultAsync<TOutput, MyError>
```

## Result construction

| boxed                               | neverthrow        |
| ----------------------------------- | ----------------- |
| `Result.Ok(value)`                  | `ok(value)`       |
| `Result.Error(error)`               | `err(error)`      |
| `Future.value(Result.Ok(value))`    | `okAsync(value)`  |
| `Future.value(Result.Error(error))` | `errAsync(error)` |

## Type-guards & accessors

```diff
- if (result.isError()) { console.log(result.error); }
+ if (result.isErr())   { console.log(result.error); }

  // .isOk() and the .value / .error accessors after narrowing are unchanged.
```

## Method renames

| boxed                           | neverthrow                                          |
| ------------------------------- | --------------------------------------------------- |
| `.flatMap(fn)`                  | `.andThen(fn)`                                      |
| `.flatMapOk(fn)`                | `.andThen(fn)`                                      |
| `.flatMapError(fn)`             | `.orElse(fn)`                                       |
| `.mapError(fn)`                 | `.mapErr(fn)`                                       |
| `.getOr(default)`               | `.unwrapOr(default)`                                |
| `.match({ Ok, Error })`         | `.match(okFn, errFn)` — positional, not object form |
| `Result.fromExecution(fn)`      | `Result.fromThrowable(fn)()`                        |
| `Result.fromAsyncExecution(fn)` | `ResultAsync.fromPromise(fn(), e => e)`             |
| `Result.all([...])`             | `Result.combine([...])`                             |

### `tap` / `tapOk` / `tapError` have no direct replacement

Inline the side-effect into a `.map(...)` (or `.mapErr(...)`) that returns
the value unchanged:

```diff
- result.tapOk((value) => logger.info("processed", value));
+ result.map((value) => {
+   logger.info("processed", value);
+   return value;
+ });
```

## Promise interop

`Future.fromPromise(promise, mapError)` becomes `ResultAsync.fromPromise(promise, mapError)`:

```diff
- const f = Future.fromPromise(api.fetch(id), (e) => new MyError(e));
+ const f = ResultAsync.fromPromise(api.fetch(id), (e) => new MyError(e));
```

If you don't need to map the error type, `.fromPromise` requires the second
argument anyway — pass `(e) => e` or a `(e) => e as Error` cast.

## Awaiting a `ResultAsync`

`ResultAsync<T, E>` is awaitable; `await` resolves to `Result<T, E>`. This
matches `Future<Result<T, E>>` from boxed — no change to call sites that
already `await` the value before checking it.

```ts
const result = await contractClient.executeWorkflow("processOrder", { ... });
if (result.isErr()) {
  // result.error: WorkflowFailedError | RuntimeClientError | ...
}
```

## End-to-end activity example

**Before (boxed):**

```ts
import { Future, Result } from "@swan-io/boxed";
import { ApplicationFailure, declareActivitiesHandler } from "@temporal-contract/worker/activity";

export const activities = declareActivitiesHandler({
  contract,
  activities: {
    sendEmail: ({ to, subject }) => {
      return Future.fromPromise(emailService.send(to, subject)).mapError((e) =>
        ApplicationFailure.create({
          type: "EMAIL_FAILED",
          message: e instanceof Error ? e.message : "Failed",
          cause: e instanceof Error ? e : undefined,
        }),
      );
    },
  },
});
```

**After (neverthrow):**

```ts
import { ResultAsync } from "neverthrow";
import { ApplicationFailure, declareActivitiesHandler } from "@temporal-contract/worker/activity";

export const activities = declareActivitiesHandler({
  contract,
  activities: {
    sendEmail: ({ to, subject }) =>
      ResultAsync.fromPromise(emailService.send(to, subject), (e) =>
        ApplicationFailure.create({
          type: "EMAIL_FAILED",
          message: e instanceof Error ? e.message : "Failed",
          cause: e instanceof Error ? e : undefined,
        }),
      ),
  },
});
```

## End-to-end client example

**Before (boxed):**

```ts
const result = await client.executeWorkflow("processOrder", { workflowId, args });
result.match({
  Ok: (output) => console.log("Order:", output),
  Error: (err) => console.error("Failed:", err),
});
```

**After (neverthrow):**

```ts
const result = await client.executeWorkflow("processOrder", { workflowId, args });
result.match(
  (output) => console.log("Order:", output),
  (err) => console.error("Failed:", err),
);
```

## Cancellation scopes

`context.cancellableScope` and `context.nonCancellableScope` previously
returned `Future<Result<T, WorkflowCancelledError>>`. They now return
`ResultAsync<T, WorkflowCancelledError>` — the only consumer change is
`.isError()` → `.isErr()`.
