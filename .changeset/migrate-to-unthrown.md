---
"@temporal-contract/contract": major
"@temporal-contract/worker": major
"@temporal-contract/client": major
"@temporal-contract/testing": major
---

Replace `neverthrow` with [`unthrown`](https://github.com/btravstack/unthrown) for the Result/error-handling spine across all packages. This is a breaking change to the public API.

**What changed**

- **`ResultAsync<T, E>` → `AsyncResult<T, E>`.** Every activity, workflow-context, child-workflow, schedule, and typed-client method that returned a `ResultAsync` now returns an `AsyncResult`. The `unthrown` peer dependency replaces `neverthrow`.
- **No `okAsync` / `errAsync`.** Lift a synchronous `Result` with `.toAsync()` instead: `ok(value).toAsync()`, `err(failure).toAsync()`. Promise boundaries use `fromPromise(promise, qualify)` / `fromSafePromise(promise)`.
- **Narrow before accessing the payload.** Both the `result.isOk()` / `isErr()` / `isDefect()` methods and the matching free functions `isOk(result)` / `isErr(result)` / `isDefect(result)` (imported from `unthrown`) are type guards; the codebase uses the methods. Narrow before touching `.value` / `.error` / `.cause`.
- **New `defect` channel.** Unanticipated throws (a thrown exception the code did not model) now surface on `unthrown`'s third `defect` channel — inspected via `result.isDefect()` / `result.cause` and re-thrown at the edge — rather than as a typed `err`. Deliberate boundary classification (e.g. mapping a Temporal SDK rejection to `WorkflowExecutionNotFoundError`) still produces a modeled `err`. `result.match({ ok, err, defect })` folds all three.
- **`WorkflowScopeError` removed.** Non-cancellation errors thrown inside `cancellableScope` / `nonCancellableScope` are unmodeled failures and now ride the `defect` channel. The scopes' error union narrows to `WorkflowCancelledError`.
- **The client's "unexpected" `RuntimeClientError` wrap is gone.** An unanticipated rejection in a client operation now surfaces as a defect, not a manufactured `RuntimeClientError`. `RuntimeClientError` is still produced by deliberate boundary classification.
- **Error classes use `TaggedError`.** The worker `WorkerError` hierarchy and the entire client `TypedClientError` hierarchy are now built with `unthrown`'s `TaggedError`, each carrying a `_tag` discriminant (foldable with `matchTags`). The `_tag` is **package-namespaced** — e.g. `"@temporal-contract/WorkflowExecutionNotFoundError"` — so it never collides with a consumer's own tags; each error's `.name` stays the bare class name for readable logs. `ChildWorkflowCancelledError` is now a sibling of `ChildWorkflowError` (distinct `_tag`) rather than a subclass — discriminate on `_tag` / `instanceof ChildWorkflowCancelledError` instead of relying on `instanceof ChildWorkflowError` matching cancellation. The worker's `ValidationError` subclasses are unchanged — they still extend Temporal's `ApplicationFailure` for terminal-failure semantics.

See the [Migrating from neverthrow](https://btravstack.github.io/temporal-contract/guide/migrating-to-unthrown) guide.
