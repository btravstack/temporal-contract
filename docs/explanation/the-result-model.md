# The result model

temporal-contract uses [unthrown](https://github.com/btravstack/unthrown)'s
`Result` and `AsyncResult` across activities, workflows, and the typed client.
The surprising part — and the part worth understanding — is that it is **not**
uniform. Different boundaries expose different shapes, deliberately.

## Three channels, not two

Most result libraries model two outcomes: success and failure. unthrown models
three.

| Channel  | Meaning                         | Inspect with   |
| -------- | ------------------------------- | -------------- |
| `ok`     | Success                         | `result.value` |
| `err`    | A failure you **modeled**       | `result.error` |
| `defect` | A failure you did **not** model | `result.cause` |

An `err` is a value you produced on purpose — `Err(...)`, or a rejection mapped
through `fromPromise(promise, qualifyFailure(...))`. It is part of your type signature,
and callers are expected to branch on it.

A `defect` is what happens when something throws that you never modeled: a
`TypeError` in a `.map` callback, an SDK that rejects in a way you did not
anticipate. It is not part of the modeled error type, and it **re-throws** when
you unwrap it — carrying the original cause and stack.

The point is that these two must not collapse together. "The card was declined"
and "the payment SDK has a bug" are different things. With two channels the
second gets quietly absorbed into your error union and handled as though it were
a business outcome. With three, it stays loud.

```typescript
if (result.isOk()) {
  result.value;
} else if (result.isErr()) {
  result.error; // anticipated — branch on it
} else if (result.isDefect()) {
  result.cause; // a bug — log it, alert on it, do not treat it as domain logic
}
```

## Why technical faults are defects

Version 8 moved `TechnicalError` and `RuntimeClientError` out of the modeled
error channel entirely.

They describe infrastructure failures — a connection that will not open, a
workflow bundle that will not compile, an unrecognized Temporal rejection.
Nobody writes domain logic branching on "the gRPC transport hiccupped". Keeping
them in `E` forced every caller to write an arm for a case they would only ever
log.

So `TypedClient.create` and `createWorker` now return `AsyncResult<_, never>`.
An empty error channel is a precise statement: _this operation has no
anticipated failure modes_. Everything that can go wrong is a defect.

```typescript
// `.get()` rethrows a defect's original cause — the right behaviour at startup
const client = await TypedClient.create({ client: temporalClient }).get();
```

## The shapes at each boundary

This is the table to internalize:

| Boundary                                            | Shape                                                                                | Why                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| **Activity implementation** returns                 | `AsyncResult<Output, ApplicationFailure \| ContractError>`                           | You author the failure. Explicit is better    |
| **Workflow calls an activity** (no declared errors) | `Promise<Output>` — throws on failure                                                | Temporal's retry policy is the handler        |
| **Workflow calls an activity** (declared errors)    | `AsyncResult<Output, ContractErrorUnion \| ActivityError \| ActivityCancelledError>` | You declared these to branch on them          |
| **Workflow calls a child workflow**                 | `AsyncResult<Output, ChildWorkflow*Error>`                                           | A peer operation; failure is usually a branch |
| **Workflow cancellation scope**                     | `AsyncResult<T, WorkflowCancelledError>`                                             | Cancellation is an expected outcome           |
| **Client calls a workflow**                         | `AsyncResult<Output, …>`                                                             | Crossing a process boundary                   |

### Why activities unwrap by default

Inside a workflow, `await context.activities.chargeCard(...)` gives you a plain
value. The `Result` is unwrapped for you.

That is not an inconsistency — it reflects who handles the failure. When an
activity fails, Temporal's retry policy takes over: it retries with backoff, and
only after exhausting the policy does the failure reach your workflow. By then
there is usually nothing sensible to do but let it propagate.

Forcing every activity call into a result fold would add ceremony to code whose
correct behaviour is almost always "let it throw":

```typescript
// what you write
const charge = await context.activities.chargeCard({ customerId, amount });
const shipment = await context.activities.createShipment({ orderId });

// what a uniform Result API would force
const charge = await context.activities.chargeCard({ customerId, amount });
if (charge.isErr()) return { status: "failed" };
const shipment = await context.activities.createShipment({ orderId });
if (shipment.isErr()) return { status: "failed" };
```

### Why declaring errors changes that

Declare an `errors` map on an activity and the call site becomes an
`AsyncResult`. That is the signal that you have failures the workflow is
_meant_ to branch on — and the exhaustive matcher then makes sure you handle
each one.

It is an opt-in trade: ceremony in exchange for typed, exhaustive handling.
Declare errors on the activities whose failures drive workflow decisions; leave
the rest throwing.

### Why child workflows never unwrap

A child workflow is a peer operation, not a retryable step. Its failure is
normally a branch in your logic — compensate, fall back, record a partial
result. So it always surfaces as a `Result`.

## Exhaustive matching

The `errCases` handler and the `*ErrCases` combinators receive a matcher rather
than the bare error:

```typescript
import { P } from "unthrown";

result.match({
  ok: (output) => output.transactionId,
  errCases: (matcher) =>
    matcher
      .with(P.tag("@temporal-contract/ContractError"), (e) => handleDomain(e))
      .with(
        P.tag("@temporal-contract/WorkflowFailedError"),
        P.tag("@temporal-contract/WorkflowExecutionNotFoundError"),
        (e) => handleInfra(e),
      ),
  defect: (cause) => report(cause),
});
```

The matcher is exhaustive: a missing tag is a compile error. That is the
mechanism that keeps error handling honest as a contract evolves — add an error
to a contract, and every fold that consumes it stops compiling until you decide
what it should do.

Every temporal-contract error class is a `TaggedError` whose `_tag` is
namespaced with the package scope, so tags never collide with yours. `.name`
stays the bare class name for readable logs.

The one exception: the worker's `ValidationError` subclasses extend Temporal's
`ApplicationFailure` rather than `TaggedError`, because Temporal's
terminal-failure semantics depend on it. A validation failure must fail the task
permanently, not retry forever.

## Where the wire boundary sits

Results do not cross the network. Temporal serializes plain values.

- An activity returns `Err(ApplicationFailure)` → the wrapper throws it →
  Temporal serializes the failure → the workflow sees a throw, or a rehydrated
  `ContractError`.
- A workflow returns a plain object → validated → serialized → the client
  rehydrates it into `Ok(value)`.

The result types are an **in-process** discipline for handling failure
explicitly. The wire format stays Temporal's.

That constraint is also why a workflow implementation returns a plain object
rather than a `Result`: its return value _is_ the serialized output. To fail
deliberately, throw a declared contract error — the wrapper converts it into an
`ApplicationFailure`, which is what makes the failure terminal rather than
infinitely retried.

## Reading a result

Narrow before touching `.value`, `.error`, or `.cause`. Both the methods and the
free functions are type guards:

```typescript
import { isErr, isOk } from "unthrown";

if (result.isOk()) result.value; // methods — what this codebase uses
if (isOk(result)) result.value; // free functions — identical
```

Extractors, and how each treats a defect:

| Method                               | On `err`                 | On `defect`        |
| ------------------------------------ | ------------------------ | ------------------ |
| `.get()`                             | throws `GetError(error)` | rethrows the cause |
| `.getOrThrow()`                      | throws the error itself  | rethrows the cause |
| `.getOr(fallback)`                   | returns the fallback     | rethrows the cause |
| `.getOrNull()` / `.getOrUndefined()` | `null` / `undefined`     | rethrows the cause |

Every one rethrows a defect. There is no extractor that quietly swallows a bug.

### `await` is not an extractor

The one trap worth internalizing. `AsyncResult` is a **success-only thenable**:
awaiting it collapses it to a `Result`, and the underlying promise never
rejects. So `await` never throws, whatever the outcome:

```typescript
// ❌ The Result is discarded. A failed signal — or an outright bug — vanishes.
await handle.signals.approve({ approvedBy: "ops" });

// ✅ Unwrap it.
(await handle.signals.approve({ approvedBy: "ops" })).getOrThrow();

// ✅ Or chain the extractor before awaiting.
await handle.signals.approve({ approvedBy: "ops" }).getOrThrow();

// ✅ Or branch.
const sent = await handle.signals.approve({ approvedBy: "ops" });
if (sent.isErr()) {
  /* ... */
}
```

This bites hardest on operations returning `AsyncResult<void, never>` — the
schedule handle's `pause` / `unpause` / `trigger` / `delete`. An empty error
channel reads like "cannot fail", but every failure there is a _defect_, and a
bare `await` drops it silently. Chain `.get()`.

## Next

- [Errors reference](/reference/errors) — every class and its channel
- [Model domain errors](/how-to/model-domain-errors)
- [Migrate from neverthrow](/how-to/migrate-from-neverthrow)
