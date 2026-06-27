---
"@temporal-contract/contract": major
"@temporal-contract/worker": major
"@temporal-contract/client": major
"@temporal-contract/testing": major
---

Upgrade to [`unthrown`](https://github.com/btravstack/unthrown) 1.0.0.

unthrown 1.0.0 renames the result constructors to PascalCase: `ok` → `Ok`, `err` → `Err`, `defect` → `Defect`. All packages are updated, and the `unthrown` peer-dependency range moves to `^1`.

**Breaking for consumers** who construct results directly (e.g. in activity implementations): replace `ok(value)` / `err(failure)` with `Ok(value)` / `Err(failure)` (and `ok(value).toAsync()` / `err(failure).toAsync()` at promise boundaries), and bump `unthrown` to `^1`. The `result.match({ ok, err, defect })` handler keys are unchanged (they are object keys, not constructors), and `matchTags` / `TaggedError` / `fromPromise` / `fromSafePromise` / `.toAsync()` and the `result.isOk()` / `isErr()` / `isDefect()` narrowing are all unchanged.

See the [Migrating from neverthrow](https://btravstack.github.io/temporal-contract/guide/migrating-to-unthrown) guide.
