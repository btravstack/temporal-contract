---
"@temporal-contract/contract": patch
"@temporal-contract/client": patch
"@temporal-contract/worker": patch
---

Bump `unthrown` to `5.0.0-beta.5`. This tracks two beta breaking changes:
`match`'s error handler key is renamed `err` → `errCases`, and the bare error
combinators gained the `*Cases` suffix (`flatMapErr` → `flatMapErrCases`,
`tapErr` → `tapErrCases`). `unthrown` also now declares `ts-pattern` as a peer
dependency, so `ts-pattern` (`^5`) is added alongside it. The peer range is
raised to `^5.0.0-beta.5`.
