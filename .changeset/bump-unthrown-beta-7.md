---
"@temporal-contract/contract": patch
"@temporal-contract/client": patch
"@temporal-contract/worker": patch
---

Bump `unthrown` to `5.0.0-beta.7` and raise the peer range to `^5.0.0-beta.7`.

Two changes come with it, neither requiring code changes here:

- **`returnType<R>()` on the built-in matcher** — pins a match's output type so
  every branch is checked against it, instead of the result being the union of
  the branch returns. Available on all five `*ErrCases` combinators, `match`'s
  `errCases` handler, and standalone `match(value)`.
- **`tapErrCases` no longer silently drops a `defect(…)` branch.** Such a branch
  now produces a `Defect` whose cause is an `AggregateError` of the branch's
  cause and the observed error, matching what a `throw` in the same position
  already did. Only a breaking change for code that relied on the value being
  discarded — this package's single `tapErrCases` call site logs and does not
  use the `defect` marker.
