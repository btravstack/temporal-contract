---
"@temporal-contract/boxed": minor
"@temporal-contract/contract": minor
"@temporal-contract/worker": minor
"@temporal-contract/client": minor
"@temporal-contract/testing": minor
---

Close part of the API gap with `@swan-io/boxed`, document the rest.

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
