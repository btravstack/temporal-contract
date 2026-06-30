---
"@temporal-contract/contract": major
"@temporal-contract/worker": major
"@temporal-contract/client": major
"@temporal-contract/testing": major
---

Upgrade to [`unthrown`](https://github.com/btravstack/unthrown) 3.0.0.

The published packages' `unthrown` peer-dependency range moves to `^3`. unthrown 3.0.0's breaking change — removing the standalone `Defect` constructor in favour of a `defect` argument passed into `fromPromise` / `fromThrowable`'s `qualify` callback — does not affect temporal-contract, which never constructs defects (every boundary maps rejections to a modeled error). Everything else we use (`Ok` / `Err`, `TaggedError`, `matchTags`, `fromPromise` / `fromSafePromise`, `result.match({ ok, err, defect })`, `.toAsync()`, and the `result.isOk()` / `isErr()` / `isDefect()` narrowing) is unchanged, so no source changes were required.

**Breaking for consumers**: bump your own `unthrown` install to `^3`.
