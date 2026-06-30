---
"@temporal-contract/contract": major
"@temporal-contract/worker": major
"@temporal-contract/client": major
"@temporal-contract/testing": major
---

Upgrade to [`unthrown`](https://github.com/btravstack/unthrown) 2.0.0.

The published packages' `unthrown` peer-dependency range moves to `^2`. unthrown 2.0.0 is API-compatible for everything temporal-contract uses — the `Ok` / `Err` / `Defect` constructors, `TaggedError`, `matchTags`, `fromPromise` / `fromSafePromise`, `result.match({ ok, err, defect })`, `.toAsync()`, and `result.isOk()` / `isErr()` / `isDefect()` narrowing are all unchanged — so no source changes were required.

**Breaking for consumers**: bump your own `unthrown` install to `^2`. There are no other code changes.
