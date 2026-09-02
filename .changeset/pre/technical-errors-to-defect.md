---
"@temporal-contract/client": patch
"@temporal-contract/contract": patch
"@temporal-contract/worker": patch
---

Route `TechnicalError` and `RuntimeClientError` to unthrown's defect channel instead of the modeled `Err` channel.

These two errors describe technical/infrastructure failures (connection/bundling faults, an unknown schedule ID, an unrecognized Temporal rejection) that are never branched on for domain logic. Per unthrown's Thesis #1, the `E` channel is only for anticipated domain failures, so they now surface as a `Defect` whose `cause` is a `TechnicalError` / `RuntimeClientError` instance — the classes stay exported so the descriptive message, `operation`, and `cause` survive for logging.

**Breaking.** Consumers who matched these on the error channel must move to the defect channel:

- `TypedClient.create` and `createWorker` now return `AsyncResult<_, never>` (was `AsyncResult<_, TechnicalError>`). Inspect setup faults via `result.isDefect()` / `match`'s `defect` handler / `recoverDefect`, not `isErr()`.
- Every modeled error union drops `RuntimeClientError` (`startWorkflow`, `signalWithStart`, `executeWorkflow`, `getHandle`, handle `queries`/`signals`/`updates`/`result`/`terminate`/`cancel`/`describe`/`fetchHistory`, the schedule handle methods, `ClientCallError`). Schedule handle methods now return `AsyncResult<_, never>`.
- Drop any `.with(tag("@temporal-contract/RuntimeClientError"), …)` / `.with(tag("@temporal-contract/TechnicalError"), …)` arm from exhaustive matchers; handle these in the `defect` arm (e.g. `recoverDefect` / `tapDefect`), matching on `cause instanceof RuntimeClientError` where needed.
