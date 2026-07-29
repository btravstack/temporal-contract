# Upgrade from 7.x to 8.0

Version 8 has two breaking changes:

1. **unthrown 5** — error combinators and `match`'s error handler take a matcher
   callback, and the bare combinators gained a `Cases` suffix.
2. **Technical errors moved to the defect channel** — `TechnicalError` and
   `RuntimeClientError` no longer appear in any modeled error union.

Both are mechanical. Budget an afternoon for a medium codebase.

::: warning 8.0 is currently a prerelease
The 8.0 line is published under the `beta` tag, so a plain
`npm install @temporal-contract/contract` still resolves 7.x. Install
explicitly:

```bash
pnpm add @temporal-contract/contract@beta @temporal-contract/worker@beta \
         @temporal-contract/client@beta unthrown@^5
```

`unthrown` itself is stable — only the `@temporal-contract/*` packages are on
the `beta` tag.

The [stable docs](https://btravstack.github.io/temporal-contract/) document
7.x; you are reading the beta docs.
:::

## 1. Bump the dependencies

All four packages version together — do not mix.

```bash
pnpm add @temporal-contract/contract@beta \
         @temporal-contract/worker@beta \
         @temporal-contract/client@beta
pnpm add -D @temporal-contract/testing@beta
pnpm add unthrown@^5.0.0
```

If an intermediate beta had you install `ts-pattern` as a peer, remove it —
unthrown's matcher is built in again as of beta.6, and unthrown has zero runtime
dependencies:

```bash
pnpm remove ts-pattern
```

If you already tracked an 8.0 beta, the standalone `tag` export is gone in
unthrown 5.0.0 — it is `P.tag` now. Drop `tag` from the import (keeping or
adding `P`) and prefix the call sites:

```diff
- import { tag } from "unthrown";
+ import { P } from "unthrown";

  result.mapErrCases((matcher) =>
-   matcher.with(tag("@temporal-contract/WorkflowFailedError"), (error) => handle(error)),
+   matcher.with(P.tag("@temporal-contract/WorkflowFailedError"), (error) => handle(error)),
  );
```

## 2. Rename the error combinators

The bare combinators gained a `Cases` suffix, and their callback now receives a
matcher rather than the error directly:

| 7.x          | 8.0               |
| ------------ | ----------------- |
| `mapErr`     | `mapErrCases`     |
| `flatMapErr` | `flatMapErrCases` |
| `tapErr`     | `tapErrCases`     |
| `recoverErr` | `recoverErrCases` |

```typescript
// 7.x
result.mapErr((error) => new WrappedError(error));

// 8.0 — one arm per tag in the union (abbreviated here; see the note below)
result.mapErrCases((matcher) =>
  matcher.with(P.tag("@temporal-contract/WorkflowFailedError"), (error) => new WrappedError(error)),
);
```

The matcher is **exhaustive**: every tag in the error union needs an arm, or it
is a compile error. That is the point — widening the union now forces every fold
to be revisited.

To keep a catch-all, match on the wildcard:

```typescript
import { P } from "unthrown";

result.mapErrCases((matcher) => matcher.with(P._, (error) => new WrappedError(error)));
```

## 3. Rename `match`'s error handler

```typescript
// 7.x
result.match({
  ok: (value) => value,
  err: (error) => handle(error),
  defect: (cause) => report(cause),
});

// 8.0
result.match({
  ok: (value) => value,
  errCases: (matcher) =>
    matcher.with(
      P.tag("@temporal-contract/WorkflowFailedError"),
      P.tag("@temporal-contract/WorkflowValidationError"),
      (error) => handle(error),
    ),
  defect: (cause) => report(cause),
});
```

`.with()` takes any number of patterns before the handler, so folding several
tags into one branch stays compact.

## 4. Move technical errors to the defect channel

This is the change most likely to need thought.

`TechnicalError` and `RuntimeClientError` describe _infrastructure_ failures — a
connection fault, a workflow bundle that will not compile, an unknown schedule
id, an unrecognized Temporal rejection. Nobody branches on them for domain
logic, so they no longer occupy the modeled `E` channel. They surface as a
**defect** whose `cause` is the error instance.

Both classes are still exported; their message, `operation`, and `cause` survive
for logging.

### Creation factories

`TypedClient.create` and `createWorker` now return `AsyncResult<_, never>`:

```typescript
// 7.x
const created = await TypedClient.create({ contract, client });
if (created.isErr()) {
  console.error("client setup failed:", created.error);
  process.exit(1);
}
const typedClient = created.value;

// 8.0
const created = await TypedClient.create({ contract, client });
if (created.isDefect()) {
  console.error("client setup failed:", created.cause); // a TechnicalError
  process.exit(1);
}
const typedClient = created.value;
```

Or, more concisely — `.get()` rethrows a defect's original cause:

```typescript
const typedClient = await TypedClient.create({ contract, client }).get();
```

The same applies to `createWorker`.

### Every other operation

`RuntimeClientError` is gone from the error union of `startWorkflow`,
`signalWithStart`, `executeWorkflow`, `getHandle`, the handle's
`queries` / `signals` / `updates` / `result` / `terminate` / `cancel` /
`describe` / `fetchHistory`, the schedule handle methods, and `ClientCallError`.

Delete any arm matching it. Because the matcher is exhaustive, TypeScript will
point at every one:

```typescript
// 7.x
result.match({
  ok: (value) => value,
  errCases: (matcher) =>
    matcher
      .with(P.tag("@temporal-contract/RuntimeClientError"), (e) => report(e)) // ❌ remove
      .with(P.tag("@temporal-contract/WorkflowFailedError"), (e) => handle(e)),
  defect: (cause) => report(cause),
});

// 8.0
result.match({
  ok: (value) => value,
  errCases: (matcher) =>
    matcher.with(P.tag("@temporal-contract/WorkflowFailedError"), (e) => handle(e)),
  defect: (cause) => {
    if (cause instanceof RuntimeClientError) {
      return report(cause); // handle it here instead
    }
    throw cause;
  },
});
```

### Schedule handles

Every `TypedScheduleHandle` method now returns `AsyncResult<void, never>` (or
`AsyncResult<ScheduleDescription, never>` for `describe`). There is no `err`
branch left to write:

```typescript
// 8.0 — `.get()` rethrows the defect's original cause.
await schedule.pause("maintenance").get();
```

::: warning A bare `await` swallows the defect
`AsyncResult` is a success-only thenable: awaiting it collapses it to a
`Result`, and the underlying promise never rejects. `await schedule.pause(...)`
on its own discards the failure. Chain `.get()`, or branch on `isDefect()`.
:::

## 5. Interceptors and middleware

If a client interceptor retried on `RuntimeClientError`, move it to
`recoverDefect`:

```typescript
// 7.x
const retryOnce: ClientInterceptor = (args, next) =>
  next().flatMapErr((error) =>
    error instanceof RuntimeClientError ? next() : Err(error).toAsync(),
  );

// 8.0
const retryOnce: ClientInterceptor = (args, next) =>
  next().recoverDefect((cause) => {
    if (cause instanceof RuntimeClientError) {
      return next();
    }
    throw cause;
  });
```

## Checklist

- [ ] All four `@temporal-contract/*` packages on the same 8.0 version
- [ ] `unthrown` resolves to `^5.0.0`
- [ ] `ts-pattern` removed if it was added for beta.5
- [ ] `tag(...)` → `P.tag(...)` if you tracked an earlier 8.0 beta
- [ ] `mapErr` / `flatMapErr` / `tapErr` / `recoverErr` → `*Cases`
- [ ] `match({ err })` → `match({ errCases })`
- [ ] `TypedClient.create` / `createWorker` use `isDefect()` or `.get()`
- [ ] No `P.tag("@temporal-contract/RuntimeClientError")` or
      `P.tag("@temporal-contract/TechnicalError")` arms remain
- [ ] `pnpm typecheck` clean

The exhaustive matcher does most of the work: once it compiles, the migration is
almost certainly complete.

## Also see

- [Migrate from neverthrow](/how-to/migrate-from-neverthrow) — if you are
  coming from a much older release
- [The result model](/explanation/the-result-model) — why the defect channel
  exists
- [Errors reference](/reference/errors)
