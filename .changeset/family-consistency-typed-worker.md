---
"@temporal-contract/worker": major
"@temporal-contract/testing": major
"@temporal-contract/contract": major
"@temporal-contract/client": major
---

Family-consistency audit: `TypedWorker.create` replaces `createWorker`, and `OkAsync`/`ErrAsync` become the canonical pre-lifted constructors.

**Breaking (worker).** The free `createWorker` function is removed in favour of a static factory on a new `TypedWorker` class — the worker-side sibling of `TypedClient.create` and the org's shared `Typed*.create()` shape (matching amqp-contract's `TypedAmqpClient.create` / `TypedAmqpWorker.create`):

- `TypedWorker.create(options)` takes the same `CreateWorkerOptions` and returns `AsyncResult<TypedWorker, never>` — bundling/connection failures stay technical defects with a `TechnicalError` cause; unwrap with `.get()`.
- `worker.run()` returns `AsyncResult<void, never>`: a worker that fails while running surfaces as a `TechnicalError`-caused defect and the underlying promise never rejects (safe to hold across a test without unhandled-rejection guards). `await worker.run().get()` rethrows at the edge.
- `worker.shutdown()` delegates to the raw worker; everything else Temporal's runtime owns (`runUntil`, `getState`, …) lives on the `worker.raw` escape hatch.

Migration: `createWorker(opts).get()` → `TypedWorker.create(opts).get()`, `await worker.run()` → `await worker.run().get()`, `worker.runUntil(...)`/`worker.getState()` → `worker.raw.runUntil(...)`/`worker.raw.getState()`.

**Breaking (testing).** `createContractTest`'s `worker` fixture now exposes the `TypedWorker` (the raw Temporal `Worker` is at `worker.raw`).

**Docs/idiom sweep (all packages).** Pre-lifted async results are now built with `OkAsync(value)` / `ErrAsync(error)` (canonical since unthrown 4.1) instead of `Ok(value).toAsync()` / `Err(error).toAsync()` throughout the docs, examples, and TSDoc; `.toAsync()` remains for lifting an existing sync `Result`.
