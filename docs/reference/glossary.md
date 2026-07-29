# Glossary

Terms used throughout these docs, and how temporal-contract uses them.

## Contract terms

**Contract** — the single definition of a Temporal application's shape:
workflows, their activities, signals, queries, updates, errors, and search
attributes, plus the task queue. Created with `defineContract`. Imported by the
worker, the client, and your tests.

**Contract error** — a domain failure declared on a contract's `errors` map.
Becomes a typed, schema-validated `ContractError` on the caller's side rather
than an opaque string type. See [Model domain
errors](/how-to/model-domain-errors).

**Global activity** — an activity declared at the contract level, reachable from
every workflow. Contrast **workflow-scoped activity**, declared on one workflow
and reachable only from it. Both share one flat runtime namespace, so names must
be unique across the whole contract.

**Standard Schema** — the [cross-library specification](https://standardschema.dev/)
that lets Zod, Valibot, and ArkType be used interchangeably. Any conforming
schema works in a contract.

**Direction-aware inference** — schemas can transform, so a value's type differs
by direction. A client passes the schema's _input_ type and receives its
_output_ type; a worker receives the _output_ type and returns the _input_ type.
Encoded as `ClientInferInput` / `ClientInferOutput` / `WorkerInferInput` /
`WorkerInferOutput`.

## Result terms

**`Result<T, E>`** — a synchronous value that is one of three things: `ok`,
`err`, or `defect`. From [unthrown](https://github.com/btravstack/unthrown).

**`AsyncResult<T, E>`** — the awaitable form. `await asyncResult` yields a
`Result<T, E>`. Chainable with `.map`, `.flatMap`, `.mapErrCases` and friends
before awaiting.

**`ok` channel** — success.

**`err` channel** — a failure you **modeled**. Part of the type signature,
meant to be branched on.

**`defect` channel** — a failure you did **not** model: a bug, an unexpected
throw, an infrastructure fault. Not part of the modeled error type. Carries the
raw failure on `result.cause` and re-throws when unwrapped, so genuine bugs
surface loudly. See [The result model](/explanation/the-result-model).

**Qualification** — turning an untyped rejection into a modeled error at a
boundary. `fromPromise(promise, qualifyFailure("TYPE"))` is the common form.

**`TaggedError`** — unthrown's base for error classes, stamping a `_tag`
discriminant. temporal-contract namespaces its tags with the package scope
(`"@temporal-contract/…"`) to avoid collisions.

**Exhaustive matcher** — the callback `errCases` and the `*ErrCases`
combinators receive. Every tag in the error union needs an arm, or it is a
compile error. `P._` is the wildcard.

## Temporal terms

**Workflow** — a durable function. Temporal records every step, so it survives
process crashes by replaying its history. Must be deterministic.

**Activity** — a single unit of side-effecting work called from a workflow.
Retried by Temporal on failure. Not replayed — its result is recorded.

**Determinism** — the property that replaying a workflow's code against its
recorded history produces the same decisions. Broken by `Date.now()`,
`Math.random()`, direct I/O, or `process.env` reads in workflow code. See
[Workflow determinism](/explanation/workflow-determinism).

**Replay** — re-executing workflow code against recorded history to rebuild
in-memory state after a crash or a worker restart.

**Task queue** — the named channel workers poll for work. Owned by the contract;
one contract maps to one queue maps to one worker deployment.

**Worker** — the process that executes workflow and activity code by polling a
task queue.

**Signal** — an asynchronous, fire-and-forget message to a running workflow. No
return value.

**Query** — a synchronous read of a running workflow's state. Must not modify
anything and must complete synchronously.

**Update** — a message that changes workflow state and returns a value to the
caller, who waits for it to be handled. A signal that reports back.

**Child workflow** — a workflow started by another workflow. Has its own
execution history, retry policy, and optionally its own task queue.

**Continue-as-new** — ending a run and atomically starting a fresh one with new
arguments and an empty history. The way to keep a long-running workflow's
history bounded. See [Continue as new](/how-to/continue-as-new).

**`ApplicationFailure`** — Temporal's first-class failure type. Carries a
`type` string that retry policies key on, an optional `details` payload, and a
`nonRetryable` flag.

**`nonRetryable`** — marks a failure permanent so Temporal stops retrying
immediately. Settable per instance via `qualifyFailure`, or per declared error on the
contract.

**Cancellation scope** — a region of workflow code that can be cancelled as a
unit. temporal-contract wraps Temporal's `CancellationScope` as
`cancellableScope` / `nonCancellableScope`, folding cancellation into the `err`
channel. See [Handle cancellation](/how-to/handle-cancellation).

**Heartbeat** — a liveness signal from a long-running activity. Required for it
to be cancellable, and lets a retry resume from a checkpoint.

**Search attribute** — an indexed field on Temporal's visibility store, used to
find executions by domain criteria. Must be registered on the namespace before
use. See [Index workflows with search
attributes](/how-to/index-workflows-with-search-attributes).

**Schedule** — a recurring spec that starts workflows, with catch-up and
overlap policies, pause/resume, and manual triggers.

**Time-skipping** — a test server that fast-forwards timers, so a workflow that
sleeps 30 days completes instantly. See [Test workflows](/how-to/test-workflows).

**Workflow id vs run id** — the workflow id is yours and stable across a
continue-as-new chain; the run id identifies one execution within it.

## Next

- [Contract surface](/reference/contract-surface)
- [The result model](/explanation/the-result-model)
- [Workflow determinism](/explanation/workflow-determinism)
