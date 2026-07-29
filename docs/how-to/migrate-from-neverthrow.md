# Migrate from neverthrow

Releases before 5.0 used [neverthrow](https://github.com/supermacro/neverthrow)
for the `Result` type. temporal-contract now uses
[unthrown](https://github.com/btravstack/unthrown) throughout — workflows,
activities, and the typed client.

If you are on a recent version and only need the 7 → 8 step, see
[Upgrade to v8](/how-to/upgrade-to-v8) instead.

## Why the change

unthrown adds a third channel. neverthrow's `Result<T, E>` has two outcomes:
success and failure. unthrown has three:

| Channel  | Meaning                                                      |
| -------- | ------------------------------------------------------------ |
| `ok`     | Success                                                      |
| `err`    | A failure you **modeled** — part of the type signature       |
| `defect` | A failure you **did not** model — a bug, an unexpected throw |

The distinction matters at a Temporal boundary. "The card was declined" is a
domain outcome your caller branches on. "The payment SDK threw a
`TypeError`" is a bug that should surface loudly, not be quietly folded into
your error union. With two channels those collapse together; with three they do
not.

A defect **re-throws** when you unwrap it, carrying the original cause and
stack.

## Swap the dependency

```bash
pnpm remove neverthrow
pnpm add unthrown
```

```typescript
// before
import { ResultAsync, ok, err, okAsync, errAsync } from "neverthrow";

// after
import { AsyncResult, Ok, Err, OkAsync, ErrAsync } from "unthrown";
```

Constructors are capitalized in unthrown.

## Type names

| neverthrow          | unthrown            |
| ------------------- | ------------------- |
| `Result<T, E>`      | `Result<T, E>`      |
| `ResultAsync<T, E>` | `AsyncResult<T, E>` |

```typescript
// before
const activity = (): ResultAsync<Payment, ApplicationFailure> => ...

// after
const activity = (): AsyncResult<Payment, ApplicationFailure> => ...
```

## Method mapping

| neverthrow                       | unthrown                               | Note                        |
| -------------------------------- | -------------------------------------- | --------------------------- |
| `ok(v)`                          | `Ok(v)`                                |                             |
| `err(e)`                         | `Err(e)`                               |                             |
| `okAsync(v)`                     | `OkAsync(v)` or `Ok(v).toAsync()`      |                             |
| `errAsync(e)`                    | `ErrAsync(e)` or `Err(e).toAsync()`    |                             |
| `ResultAsync.fromPromise(p, f)`  | `fromPromise(p, f)`                    | free function               |
| `ResultAsync.fromSafePromise(p)` | `fromSafePromise(p)`                   | free function               |
| `.map(f)`                        | `.map(f)`                              | unchanged                   |
| `.andThen(f)`                    | `.flatMap(f)`                          | renamed                     |
| `.mapErr(f)`                     | `.mapErrCases(m => …)`                 | takes a matcher             |
| `.orElse(f)`                     | `.recoverErrCases(m => …)`             | takes a matcher             |
| `.match(ok, err)`                | `.match({ ok, errCases, defect })`     | object form, three channels |
| `Result.combine([…])`            | `all([…])`                             | free function               |
| `.isOk()` / `.isErr()`           | `.isOk()` / `.isErr()` / `.isDefect()` | plus free functions         |
| `.unwrapOr(v)`                   | `.getOr(v)`                            |                             |
| `._unsafeUnwrap()`               | `.getOrThrow()`                        |                             |

## `andThen` becomes `flatMap`

```typescript
// before
fetchOrder(id)
  .andThen((order) => chargeCard(order))
  .map((charge) => charge.id);

// after
fetchOrder(id)
  .flatMap((order) => chargeCard(order))
  .map((charge) => charge.id);
```

## Error handling takes a matcher

This is the biggest shift. Anything touching the error channel receives an
exhaustive matcher instead of the bare error:

```typescript
// before
result.mapErr((error) => new WrappedError(error));

// after — one arm per tag in the union (abbreviated here; see the note below)
import { P } from "unthrown";

result.mapErrCases((matcher) =>
  matcher.with(P.tag("@temporal-contract/WorkflowFailedError"), (error) => new WrappedError(error)),
);
```

The matcher must cover the whole union — a missing tag is a compile error. For
a genuine catch-all:

```typescript
import { P } from "unthrown";

result.mapErrCases((matcher) => matcher.with(P._, (error) => new WrappedError(error)));
```

`.with()` accepts several patterns before the handler, so folding a wide union
into one branch is compact:

```typescript
matcher.with(
  P.tag("@temporal-contract/WorkflowNotFoundError"),
  P.tag("@temporal-contract/WorkflowValidationError"),
  P.tag("@temporal-contract/WorkflowFailedError"),
  (error) => report(error),
);
```

## `match` is an object with three channels

```typescript
// before
const message = result.match(
  (value) => `charged ${value.transactionId}`,
  (error) => `failed: ${error.message}`,
);

// after
const message = result.match({
  ok: (value) => `charged ${value.transactionId}`,
  errCases: (matcher) =>
    matcher.with(
      P.tag("@temporal-contract/WorkflowFailedError"),
      P.tag("@temporal-contract/WorkflowValidationError"),
      (error) => `failed: ${error.message}`,
    ),
  defect: (cause) => `unexpected: ${String(cause)}`,
});
```

Forgetting `defect` is a compile error, which is deliberate — it is the channel
you most want not to ignore.

## Narrowing

Both the methods and the free functions are type guards:

```typescript
import { isDefect, isErr, isOk } from "unthrown";

// methods — what this codebase uses
if (result.isOk()) result.value;
if (result.isErr()) result.error;
if (result.isDefect()) result.cause;

// free functions — identical behaviour
if (isOk(result)) result.value;
```

Narrow before touching `.value`, `.error`, or `.cause`.

## Error classes

unthrown's `TaggedError` stamps a `_tag` discriminant used by the matcher:

```typescript
import { TaggedError } from "unthrown";

class PaymentDeclined extends TaggedError("PaymentDeclined")<{
  readonly customerId: string;
}> {}
```

temporal-contract's own classes namespace their tag with the package scope —
`"@temporal-contract/WorkflowFailedError"` — so they never collide with yours.
Their `.name` stays the bare class name for readable logs.

Note the exception: the worker's `ValidationError` subclasses still extend
Temporal's `ApplicationFailure` rather than `TaggedError`, because Temporal's
terminal-failure semantics depend on it.

## A full activity, before and after

```typescript
// before — neverthrow
import { ResultAsync, err, ok } from "neverthrow";

const chargeCard = ({ customerId, amount }) =>
  ResultAsync.fromPromise(gateway.charge(customerId, amount), (error) =>
    ApplicationFailure.create({ type: "CHARGE_FAILED", cause: error as Error }),
  ).andThen((charge) =>
    charge.declined
      ? err(ApplicationFailure.create({ type: "DECLINED", nonRetryable: true }))
      : ok({ transactionId: charge.id }),
  );
```

```typescript
// after — unthrown
import { Err, Ok, fromPromise } from "unthrown";
import { qualify } from "@temporal-contract/worker/activity";

const chargeCard = ({ customerId, amount }) =>
  fromPromise(gateway.charge(customerId, amount), qualify("CHARGE_FAILED")).flatMap((charge) =>
    charge.declined
      ? Err(ApplicationFailure.create({ type: "DECLINED", nonRetryable: true }))
      : Ok({ transactionId: charge.id }),
  );
```

`qualify` is a temporal-contract helper that collapses the hand-written
`ApplicationFailure.create` mapper into one call.

## Combining results

```typescript
// before
const combined = Result.combine([validateA(a), validateB(b)]);

// after
import { all } from "unthrown";

const combined = all([validateA(a), validateB(b)]);
```

`all` fails on the first error, like `Result.combine`. `allAsync` is the
`AsyncResult` variant, and `allFromDict` combines a record instead of an array.

## Also see

- [The result model](/explanation/the-result-model) — the three channels in
  temporal-contract specifically
- [Upgrade to v8](/how-to/upgrade-to-v8) — the more recent breaking change
- [unthrown's own migration guide](https://btravstack.github.io/unthrown/how-to/migrate-from-neverthrow)
