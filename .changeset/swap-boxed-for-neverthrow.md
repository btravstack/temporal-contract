---
"@temporal-contract/contract": major
"@temporal-contract/worker": major
"@temporal-contract/client": major
"@temporal-contract/testing": major
---

Replace `@swan-io/boxed` with `neverthrow` across the entire surface.

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
