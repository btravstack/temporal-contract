# Migrating from neverthrow to unthrown

`temporal-contract` previously used [`neverthrow`] for its `Result` /
`ResultAsync` pattern. Starting in this major version it uses [`unthrown`]
instead. The shape of the API surface is the same — signals, queries,
updates, activities, and the client all still return a `Result`-like value —
but the type and function names differ, narrowing now uses **free
functions**, and there is a new third outcome channel: `defect`.

This page is an end-to-end mapping for upgrading existing code.

[`neverthrow`]: https://github.com/supermacro/neverthrow
[`unthrown`]: https://github.com/btravstack/unthrown

## Why the change

- **A third channel for bugs**: unthrown separates _anticipated_ failures
  (`err`) from _unanticipated_ ones (`defect`). Modeled boundary errors stay
  in your type signature; unexpected throws surface as defects that re-throw
  on `await`/unwrap instead of being silently swallowed.
- **Tagged errors**: error classes built with `TaggedError(...)` carry a
  `_tag` discriminant, enabling exhaustive `matchTags(...)` folds.
- **Sound narrowing**: free functions `isOk` / `isErr` / `isDefect` narrow
  the type correctly, instead of relying on method-based type guards.

## Drop the dep, add the new one

```diff
  // package.json
  "dependencies": {
-   "neverthrow": "^8"
+   "unthrown": "^0.1.0"
  }
```

```diff
- import { ResultAsync, ok, err, okAsync, errAsync } from "neverthrow";
+ import { fromPromise, ok, err, isOk, isErr, isDefect } from "unthrown";
```

## Type signatures

`ResultAsync<T, E>` is renamed to `AsyncResult<T, E>`. `Result<T, E>` keeps
the same name but is now imported from `"unthrown"`.

```diff
- (args: TInput): ResultAsync<TOutput, MyError>
+ (args: TInput): AsyncResult<TOutput, MyError>
```

## API mapping

| neverthrow                                   | unthrown                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `import { ResultAsync } from "neverthrow"`   | `import { fromPromise } from "unthrown"`                               |
| type `ResultAsync<T, E>`                     | type `AsyncResult<T, E>`                                               |
| type `Result<T, E>`                          | `Result<T, E>` (now from `"unthrown"`)                                 |
| `ok(v)` / `err(e)`                           | `ok(v)` / `err(e)` (from `"unthrown"`)                                 |
| `okAsync(v)`                                 | `ok(v).toAsync()` (no `okAsync`)                                       |
| `errAsync(e)`                                | `err(e).toAsync()` (no `errAsync`)                                     |
| `ResultAsync.fromPromise(promise, errFn)`    | `fromPromise(promise, errFn)`                                          |
| `ResultAsync.fromSafePromise(promise)`       | `fromSafePromise(promise)`                                             |
| `.andThen(fn)`                               | `.flatMap(fn)`                                                         |
| `.map(fn)` / `.mapErr(fn)` / `.orElse(fn)`   | `.map(fn)` / `.mapErr(fn)` / `.orElse(fn)`                             |
| `Result.combine([...])`                      | `all([...])`                                                           |
| `result.match(okFn, errFn)` (positional)     | `result.match({ ok, err, defect })` (object, 3 channels)               |
| `result.isOk()` / `result.isErr()` to narrow | `isOk(result)` / `isErr(result)` / `isDefect(result)` (free functions) |

## `okAsync` / `errAsync` are gone

unthrown has no `okAsync` / `errAsync`. Build a synchronous `Result` and lift
it to an `AsyncResult` with `.toAsync()`:

```diff
- import { okAsync, errAsync } from "neverthrow";
+ import { ok, err } from "unthrown";

- return okAsync({ sent: true });
+ return ok({ sent: true }).toAsync();

- return errAsync(new MyError());
+ return err(new MyError()).toAsync();
```

## Narrowing: free functions, not methods

In neverthrow you narrowed with the `.isOk()` / `.isErr()` **methods**. In
unthrown those methods return a plain boolean and do **not** narrow the type.
Use the free functions `isOk` / `isErr` / `isDefect` instead:

```diff
- if (result.isErr()) {
+ import { isErr } from "unthrown";
+
+ if (isErr(result)) {
    console.error(result.error);
    return;
  }
  console.log(result.value);
```

## The new `defect` channel

unthrown models **three** outcomes, not two:

- **`ok`** — success.
- **`err`** — a deliberate, anticipated failure that is part of your type
  signature (returned with `err(...)` / `err(...).toAsync()`, or produced by
  mapping a rejection through `fromPromise(promise, errFn)`).
- **`defect`** — an _unanticipated_ failure (a bug): an unexpected throw that
  was never modeled. It carries the raw failure on `result.cause` and
  **re-throws** when you `await`/unwrap it, so genuine bugs surface loudly.

This is a **behavior change**. Under neverthrow, an unexpected throw inside a
chain was generally coerced into the typed error channel. Under unthrown it
becomes a `defect` instead, distinct from your modeled `err` values. Inspect
it with `isDefect(result)` / `result.cause`, or handle all three at once:

```ts
import { isOk, isErr, isDefect } from "unthrown";

const result = await client.executeWorkflow("processOrder", { workflowId, args });

if (isOk(result)) {
  console.log(result.value);
} else if (isErr(result)) {
  console.error("Modeled failure:", result.error);
} else if (isDefect(result)) {
  console.error("Unexpected failure (bug):", result.cause);
}
```

> [!NOTE]
> The worker's previous `WorkflowScopeError` has been **removed**. The
> unexpected conditions it used to model now surface on the `defect` channel
> via `result.cause` rather than as a typed `err`. Stop matching on
> `WorkflowScopeError`; handle the `defect` channel instead.

## `match` is now object form with three channels

```diff
- result.match(
-   (output) => console.log("Order:", output),
-   (err) => console.error("Failed:", err),
- );
+ result.match({
+   ok: (output) => console.log("Order:", output),
+   err: (error) => console.error("Failed:", error),
+   defect: (cause) => console.error("Unexpected:", cause),
+ });
```

Always add the `defect` handler — it is a required, distinct channel.

## Error classes: `TaggedError`

Error classes are now built with `TaggedError(...)`, which stamps each class
with a `_tag` discriminant:

```diff
- export class PaymentDeclined extends Error {
-   constructor(public readonly customerId: string) {
-     super("Payment declined");
-   }
- }
+ import { TaggedError } from "unthrown";
+
+ export class PaymentDeclined extends TaggedError("PaymentDeclined")<{
+   readonly customerId: string;
+ }> {}
```

Because every tagged error carries a `_tag`, unthrown's `matchTags` folds a
`Result` exhaustively by tag, with dedicated `Ok` and `Defect` channels:

```ts
import { matchTags } from "unthrown";

const message = matchTags(result, {
  Ok: (value) => `charged ${value.transactionId}`,
  PaymentDeclined: (e) => `declined for ${e.customerId}`,
  GatewayTimeout: (e) => `timed out after ${e.elapsedMs}ms`,
  Defect: (cause) => `unexpected: ${String(cause)}`,
});
```

> [!NOTE]
> The worker's `ValidationError` subclasses are the exception — they still
> extend Temporal's `ApplicationFailure` rather than `TaggedError`.

## End-to-end activity example

**Before (neverthrow):**

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

**After (unthrown):**

```ts
import { fromPromise } from "unthrown";
import { ApplicationFailure, declareActivitiesHandler } from "@temporal-contract/worker/activity";

export const activities = declareActivitiesHandler({
  contract,
  activities: {
    sendEmail: ({ to, subject }) =>
      fromPromise(emailService.send(to, subject), (e) =>
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

**Before (neverthrow):**

```ts
const result = await client.executeWorkflow("processOrder", { workflowId, args });
result.match(
  (output) => console.log("Order:", output),
  (err) => console.error("Failed:", err),
);
```

**After (unthrown):**

```ts
const result = await client.executeWorkflow("processOrder", { workflowId, args });
result.match({
  ok: (output) => console.log("Order:", output),
  err: (error) => console.error("Failed:", error),
  defect: (cause) => console.error("Unexpected:", cause),
});
```

## Combining results

`Result.combine([...])` becomes `all([...])`:

```diff
- import { Result } from "neverthrow";
- const combined = Result.combine([validateA(a), validateB(b)]);
+ import { all } from "unthrown";
+ const combined = all([validateA(a), validateB(b)]);
```

## Cancellation scopes

`context.cancellableScope` and `context.nonCancellableScope` previously
returned `ResultAsync<T, WorkflowCancelledError>`. They now return
`AsyncResult<T, WorkflowCancelledError>` — narrow the resolved `Result` with
`isErr(result)` (free function) instead of `result.isErr()`.

## See Also

- [Result Pattern](/guide/result-pattern)
- [Migrating from @swan-io/boxed](/guide/migrating-to-neverthrow) (the
  earlier migration, kept for history)
