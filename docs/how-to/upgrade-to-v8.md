# Upgrade from 7.x to 8.0

Version 8 has four headline breaking changes:

1. **unthrown 5** — error combinators and `match`'s error handler take a matcher
   callback, and the bare combinators gained a `Cases` suffix.
2. **Technical errors moved to the defect channel** — `TechnicalError` and
   `RuntimeClientError` no longer appear in any modeled error union.
3. **The client split in two** — `TypedClient` is connection-scoped;
   `TypedClient.create({ client }).for(contract)` hands out a contract-bound
   `ContractClient`.
4. **Each boundary parses exactly once** — the sender validates but transmits
   the original value; the receiver parses. Transforming schemas are no longer
   applied twice.

Plus a set of smaller renames and semantic fixes, each with its own section
below. Most are mechanical. Budget an afternoon for a medium codebase.

::: warning 8.0 is currently a prerelease
The 8.0 line is published under the `beta` tag, so a plain
`npm install @temporal-contract/contract` still resolves 7.x. Install
explicitly:

```bash
pnpm add @temporal-contract/contract@beta @temporal-contract/worker@beta \
         @temporal-contract/client@beta unthrown@^5
```

`unthrown` itself is stable — only the `@temporal-contract/*` packages are on
the `beta` tag.

The [stable docs](https://btravstack.github.io/temporal-contract/) document
7.x; you are reading the beta docs.
:::

## 1. Bump the dependencies

All four packages version together — do not mix.

```bash
pnpm add @temporal-contract/contract@beta \
         @temporal-contract/worker@beta \
         @temporal-contract/client@beta
pnpm add -D @temporal-contract/testing@beta
pnpm add unthrown@^5.0.0
```

If an intermediate beta had you install `ts-pattern` as a peer, remove it —
unthrown's matcher is built in again as of unthrown `5.0.0-beta.6`, and unthrown
has zero runtime dependencies:

```bash
pnpm remove ts-pattern
```

If you already tracked an 8.0 beta, the standalone `tag` export is gone in
unthrown 5.0.0 — it is `P.tag` now. Drop `tag` from the import (keeping or
adding `P`) and prefix the call sites:

```diff
- import { tag } from "unthrown";
+ import { P } from "unthrown";

  result.mapErrCases((matcher) =>
-   matcher.with(tag("@temporal-contract/WorkflowFailedError"), (error) => handle(error)),
+   matcher.with(P.tag("@temporal-contract/WorkflowFailedError"), (error) => handle(error)),
  );
```

## 2. Rename the error combinators

The bare combinators gained a `Cases` suffix, and their callback now receives a
matcher rather than the error directly:

| 7.x          | 8.0               |
| ------------ | ----------------- |
| `mapErr`     | `mapErrCases`     |
| `flatMapErr` | `flatMapErrCases` |
| `tapErr`     | `tapErrCases`     |
| `recoverErr` | `recoverErrCases` |

```typescript
// 7.x
result.mapErr((error) => new WrappedError(error));

// 8.0 — one arm per tag in the union (abbreviated here; see the note below)
result.mapErrCases((matcher) =>
  matcher.with(P.tag("@temporal-contract/WorkflowFailedError"), (error) => new WrappedError(error)),
);
```

The matcher is **exhaustive**: every tag in the error union needs an arm, or it
is a compile error. That is the point — widening the union now forces every fold
to be revisited.

To keep a catch-all, match on the wildcard:

```typescript
import { P } from "unthrown";

result.mapErrCases((matcher) => matcher.with(P._, (error) => new WrappedError(error)));
```

## 3. Rename `match`'s error handler

```typescript
// 7.x
result.match({
  ok: (value) => value,
  err: (error) => handle(error),
  defect: (cause) => report(cause),
});

// 8.0
result.match({
  ok: (value) => value,
  errCases: (matcher) =>
    matcher.with(
      P.tag("@temporal-contract/WorkflowFailedError"),
      P.tag("@temporal-contract/WorkflowValidationError"),
      (error) => handle(error),
    ),
  defect: (cause) => report(cause),
});
```

`.with()` takes any number of patterns before the handler, so folding several
tags into one branch stays compact.

## 4. Move technical errors to the defect channel

This is the change most likely to need thought.

`TechnicalError` and `RuntimeClientError` describe _infrastructure_ failures — a
connection fault, a workflow bundle that will not compile, an unknown schedule
id, an unrecognized Temporal rejection. Nobody branches on them for domain
logic, so they no longer occupy the modeled `E` channel. They surface as a
**defect** whose `cause` is the error instance.

Both classes are still exported; their message, `operation`, and `cause` survive
for logging.

### Creation factories

`TypedClient.create` and `TypedWorker.create` now return `AsyncResult<_, never>`:

```typescript
// 7.x
const created = await TypedClient.create({ contract, client });
if (created.isErr()) {
  console.error("client setup failed:", created.error);
  process.exit(1);
}
const typedClient = created.value;

// 8.0 — note the contract is gone from `create`; see the client-split
// section below.
const created = await TypedClient.create({ client });
if (created.isDefect()) {
  console.error("client setup failed:", created.cause); // a TechnicalError
  process.exit(1);
}
// The error channel is `never`, so `.get()` unwraps directly. (Reading
// `created.value` after only an `isDefect()` guard does not compile — the
// non-defect branch is still `Ok | Err`, and `Err` has no `.value`.)
const typedClient = created.get();
```

Or, more concisely — `.get()` rethrows a defect's original cause:

```typescript
const typedClient = await TypedClient.create({ client }).get();
```

The same applies to the worker factory. The deprecated `createWorkerOrThrow`
migration alias is removed in 8.0 — use `TypedWorker.create(...).get()`.

### Every other operation

`RuntimeClientError` is gone from the error union of `startWorkflow`,
`signalWithStart`, `executeWorkflow`, `getHandle`, the handle's
`queries` / `signals` / `updates` / `result` / `terminate` / `cancel` /
`describe` / `fetchHistory`, the schedule handle methods, and `ClientCallError`.

Delete any arm matching it. Because the matcher is exhaustive, TypeScript will
point at every one:

```typescript
// 7.x
result.match({
  ok: (value) => value,
  errCases: (matcher) =>
    matcher
      .with(P.tag("@temporal-contract/RuntimeClientError"), (e) => report(e)) // ❌ remove
      .with(P.tag("@temporal-contract/WorkflowFailedError"), (e) => handle(e)),
  defect: (cause) => report(cause),
});

// 8.0
result.match({
  ok: (value) => value,
  errCases: (matcher) =>
    matcher.with(P.tag("@temporal-contract/WorkflowFailedError"), (e) => handle(e)),
  defect: (cause) => {
    if (cause instanceof RuntimeClientError) {
      return report(cause); // handle it here instead
    }
    throw cause;
  },
});
```

### Schedule handles

Every `TypedScheduleHandle` method now returns
`AsyncResult<void, ScheduleNotFoundError>` (or
`AsyncResult<ScheduleDescription, ScheduleNotFoundError>` for `describe`). The
one _anticipated_ failure — the schedule does not exist on the server — is
modeled; everything else (transport faults, unrecognized rejections) rides the
defect channel:

```typescript
// 8.0 — the modeled error is `ScheduleNotFoundError`, so use `.getOrThrow()`
// (it throws the modeled `Err`, or rethrows a defect's cause). `.get()` would
// NOT compile here — it is only valid when the error channel is `never`.
await schedule.pause("maintenance").getOrThrow();
```

See the [schedules section](#_11-schedules-typed-errors-and-a-fuller-surface)
below for the full 8.0 schedule surface.

::: warning A bare `await` swallows the failure
`AsyncResult` is a success-only thenable: awaiting it collapses it to a
`Result`, and the underlying promise never rejects. `await schedule.pause(...)`
on its own discards the outcome — the modeled `ScheduleNotFoundError` (an `Err`,
not a defect) included. Chain `.getOrThrow()`, or branch on `isErr()`.
:::

## 5. Interceptors and middleware

If a client interceptor retried on `RuntimeClientError`, move it to
`recoverDefect`:

```typescript
// 7.x
const retryOnce: ClientInterceptor = (args, next) =>
  next().flatMapErr((error) =>
    error instanceof RuntimeClientError ? next() : Err(error).toAsync(),
  );

// 8.0
const retryOnce: ClientInterceptor = (args, next) =>
  next().recoverDefect((cause) => {
    if (cause instanceof RuntimeClientError) {
      return next();
    }
    throw cause;
  });
```

## 6. Split the client: `create` then `for`

A client is a _connection_; a contract is a _schema_. 8.0 decouples them:
`TypedClient` is connection-scoped (no type parameter, no contract), and
binding a contract via `for()` hands out a `ContractClient<TContract>` that
carries everything the old contract-coupled client had.

| 7.x                                                | 8.0                                            |
| -------------------------------------------------- | ---------------------------------------------- |
| `TypedClient.create({ contract, client })`         | `TypedClient.create({ client }).for(contract)` |
| `TypedClient<typeof contract>` (type annotation)   | `ContractClient<typeof contract>`              |
| `TypedClient.createOrThrow(contract, client, ...)` | removed — use `create(...).get()`              |
| `CreateTypedClientOptions`                         | `CreateClientOptions`                          |

```typescript
// 7.x — one client per contract, constructed per contract
import { TypedClient } from "@temporal-contract/client";

const typedClient = await TypedClient.create({ contract: orderContract, client }).get();
await typedClient.startWorkflow("processOrder", { workflowId, args });

// 8.0 — one client per connection, contracts bound freely
import { TypedClient, type ContractClient } from "@temporal-contract/client";

const typedClient = await TypedClient.create({ client }).get(); // once, at startup
const orders: ContractClient<typeof orderContract> = typedClient.for(orderContract);
await orders.startWorkflow("processOrder", { workflowId, args });
```

`for()` is synchronous, infallible, and memoized per contract identity —
`for(c) === for(c)` — so calling it per request is free. One process serving
two contracts is now one connection: `typedClient.for(otherContract)`.

While migrating, a stray 7.x-style `TypedClient<typeof x>` annotation fails
loudly — `TypedClient` no longer takes a type argument.

### `WorkflowNotFoundError` is now `WorkflowNotInContractError`

The old name squatted on Temporal SDK terminology while meaning something
different — the _name is not on the contract_, a programming error. Rename the
class and every matcher arm:

```diff
- matcher.with(P.tag("@temporal-contract/WorkflowNotFoundError"), (e) => ...)
+ matcher.with(P.tag("@temporal-contract/WorkflowNotInContractError"), (e) => ...)
```

`WorkflowExecutionNotFoundError` (the _execution_ does not exist on the
server) is unchanged.

### `getHandle` is synchronous now

Contract lookup needs no I/O, so `getHandle` returns a plain `Result` instead
of an `AsyncResult` — drop the `await`. It also accepts an options object:
`runId` (bind a specific execution), plus Temporal's `firstExecutionRunId` and
`followRuns` passthroughs.

```typescript
// 7.x
const bound = await typedClient.getHandle("processOrder", "order-123");

// 8.0 — sync Result now; `.getOrThrow()` throws the modeled
// WorkflowNotInContractError (or rethrows a defect's cause).
const handle = orders.getHandle("processOrder", "order-123").getOrThrow();

// Or branch explicitly — but reading `.value` after only an `isErr()` guard
// does NOT compile (the non-Err branch is still `Ok | Defect`, and `Defect`
// has no `.value`); narrow with `isOk()`:
const bound = orders.getHandle("processOrder", "order-123");
if (bound.isOk()) {
  useHandle(bound.value);
} else if (bound.isErr()) {
  throw bound.error; // WorkflowNotInContractError
}

// 8.0 — bind a specific run
const pinned = orders.getHandle("processOrder", "order-123", { runId });
```

### Deleted type exports

Six unused `ClientInfer*` aliases are gone: `ClientInferWorkflow`,
`ClientInferActivity`, `ClientInferWorkflows`, `ClientInferActivities`,
`ClientInferWorkflowActivities`, `ClientInferWorkflowContextActivities`.
Still exported: `ClientInferInput`, `ClientInferOutput`, `ClientInferSignal`,
`ClientInferQuery`, `ClientInferUpdate`, `ClientInferWorkflowSignals`,
`ClientInferWorkflowQueries`, `ClientInferWorkflowUpdates`.

### New surface worth adopting

Not breaking, but part of the same overhaul:

- **`typedClient.raw`** — the underlying `@temporalio/client` `Client`, for
  anything the typed surface does not cover (`raw.workflow.list(...)`,
  `raw.workflow.count(...)`). Bypasses validation and interceptors.
- **`handle.runId` / `handle.firstExecutionRunId`** — carried on typed
  handles when known.
- **`handle.startUpdate(name, options)`** — start an update without waiting
  for its result; returns a `TypedWorkflowUpdateHandle` whose `result()`
  parses the outcome. The `updates` map keeps its execute-and-wait shape.
- **`WorkflowValidationError.workflowId`** — the failing workflow id, carried
  on client-side validation errors.
- **Omittable payloads** — for a signal/query/update whose input schema
  accepts `undefined` (see the [input-less definitions](#input-less-signals-queries-and-updates)
  below), the client-side payload argument is optional:
  `handle.queries.getStatus()`.

## 7. Wire format: each boundary parses exactly once

::: warning Behavioral change
This changes what is transmitted, not any type. If anything relies on
receiving the send-side _transformed_ value, it is affected.
:::

In 7.x both sides of every boundary ran the same schema and the sender
transmitted the **parsed** value — so a transforming schema (`z.coerce.*`,
`.transform(...)`) was applied twice, silently corrupting data.

In 8.0 the sender still **validates** (you get the same typed
`WorkflowValidationError` / `Err` before anything crosses the network) but
transmits the caller's **original** value; the receiving side parses it. Each
transform now applies exactly once per boundary. This holds for workflow
input/output, activities in both directions, signals, queries, updates, and
child workflows.

What to check:

- Schemas with transforms that _relied_ on the double application (rare, and
  previously a bug) now see the single-parse value.
- Anything reading payloads off the wire — the Temporal Web UI, raw SDK
  clients, history exports — now sees the sender's original value, not the
  parsed one.
- A contract error's `data` is transmitted as the constructor's original
  argument: `ApplicationFailure.details[0]` carries the **pre-transform**
  value, and the receiving side parses it against the declared schema.

Idempotent schemas (no coercion, no transforms — the common case) are
unaffected.

## 8. Invalid signals are dropped, not fatal

In 7.x a signal payload failing its schema threw
`SignalInputValidationError` — a non-retryable `ApplicationFailure` — from the
signal handler, **terminally failing the whole workflow execution**. Wrong for
a fire-and-forget message any stale client can send.

In 8.0 the worker **drops the invalid signal and logs a warning** (via
`@temporalio/workflow`'s replay-aware `log.warn`, with the signal name and the
schema issues). The execution continues untouched.

- `SignalInputValidationError` no longer exists — delete any `instanceof`
  check or import.
- Client-side, sending a malformed signal still fails early with
  `SignalValidationError` before dispatch — nothing changed there.
- Queries and updates keep their existing semantics: an invalid query/update
  payload rejects that query/update, never the execution.

## 9. Worker: renames and stricter declaration checks

### `qualify` → `qualifyFailure`, now with required triage

Renamed (no alias kept) **and** given a required `expected` discriminator — see
[§12](#_12-second-breaking-pass-8-0-audit-remediation) for the full rationale.
`qualifyFailure` no longer blanket-wraps every rejection; you name which causes
are modeled business failures, and everything else rides the defect channel:

```diff
- import { declareActivitiesHandler, qualify } from "@temporal-contract/worker/activity";
+ import { declareActivitiesHandler, qualifyFailure } from "@temporal-contract/worker/activity";

-       fromPromise(gateway.charge(customerId, amount), qualify("CHARGE_FAILED"))
+       fromPromise(gateway.charge(customerId, amount), qualifyFailure("CHARGE_FAILED", { expected: GatewayError }))
```

### `createWorker` → `TypedWorker.create`

The free `createWorker` function is replaced by a static factory on a
`TypedWorker` class — the worker-side sibling of `TypedClient.create` (the
same `Typed*.create()` shape used across the family). It takes the same
options and returns `AsyncResult<TypedWorker, never>`; the underlying
Temporal `Worker` stays reachable as `worker.raw`.

```diff
- import { createWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";
+ import { TypedWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";

- const worker = await createWorker({ contract, connection, workflowsPath, activities }).get();
+ const worker = await TypedWorker.create({ contract, connection, workflowsPath, activities }).get();

- await worker.run();
+ await worker.run().get();
```

`TypedWorker.run()` returns `AsyncResult<void, never>` — a worker that fails
while running is a defect (a `TechnicalError` cause), and the underlying
promise never rejects, so it is safe to hold onto across a test.
`worker.shutdown()` delegates to the raw worker; anything else Temporal
offers (`runUntil`, `getState`) lives on `worker.raw`.

### `createWorkerOrThrow` is removed

The deprecated throwing alias goes the same way as the client's
`createOrThrow`: `TypedWorker.create` returns `AsyncResult<TypedWorker, never>`,
so `.get()` gives the same throw-on-defect behavior with the original cause.

```diff
- const worker = await createWorkerOrThrow({ contract, connection, workflowsPath, activities });
+ const worker = await TypedWorker.create({ contract, connection, workflowsPath, activities }).get();
```

### Contract misuse fails the execution instead of hanging it

Binding a signal/query/update handler for a name the contract does not
declare, using an async-validating schema where Temporal requires synchronous
validation, or reaching an activity no options cover used to throw a plain
`Error` inside the workflow sandbox — which Temporal treats as a Workflow Task
failure and retries **forever**, leaving the execution silently `Running`.

8.0 introduces `ContractMisuseError` (a non-retryable `ApplicationFailure`)
at all such sites: a contract-misuse bug now fails the execution terminally
with a clear message. If you monitored for stuck executions caused by these
bugs, they now surface as failed executions instead.

### Workflow-only workers

`activities` is now optional on `TypedWorker.create`. Omit it and the worker only
polls for Workflow Tasks — the split-deployment pattern where workflow and
activity workers scale independently on the same task queue:

```typescript
import { TypedWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";

const worker = await TypedWorker.create({
  contract: orderContract,
  connection,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  // no `activities` — workflow-only worker
}).get();
```

Relatedly, a workflow that declares no activities no longer needs an empty
`{}` entry in the `declareActivitiesHandler` map.

### `declareActivitiesHandler` fails fast

Declaration now iterates the contract's **definitions**: a declared activity
with no implementation throws at declaration time (instead of an opaque
"activity not registered" on first dispatch), and a stray key — an
implementation for an activity the contract never declared — throws
`ActivityDefinitionNotFoundError`. If your implementation map carried stale
entries, this surfaces them.

### Typed child-workflow handles grew

`TypedChildWorkflowHandle` now carries `firstExecutionRunId` and a typed
`signals` map — one sender per signal the child declares, validated on send
and parsed by the child on receive:

```typescript
const started = await context.startChildWorkflow(orderContract, "collectPayment", {
  workflowId: `payment-${order.orderId}`,
  args: { customerId: order.customerId, amount: order.total },
});

if (started.isOk()) {
  await started.value.signals.applyDiscount({ percent: 10 });
}
```

## 10. Contract package changes

### Strict root validation, without zod

`defineContract`'s structural validation is now hand-rolled — **zod is gone
from the contract package's runtime dependencies** (your schemas can of course
still be zod). The root shape check became strict: an unknown key on the
contract literal (`taskQueue`, `workflows`, `activities` are the known ones)
is now rejected at `defineContract` time, matching how `defaultOptions` was
already validated.

### Activity-name collisions, recalibrated

- **Sharing the same activity object** across workflows is now allowed —
  reference equality means it is one activity, not a collision.
- Two _different_ definitions under the same name is still an error, and the
  message now recommends hoisting the shared activity to the contract's
  global `activities` block.
- A **workflow name colliding with a global activity name** is now rejected —
  they share the root of the worker's implementations map.

### Input-less signals, queries, and updates

`input` is now optional on `defineSignal` / `defineQuery` / `defineUpdate`.
Omitted, the definition carries a materialized `UndefinedInputSchema` (a new
exported type) whose validated value is always `undefined` — no more
`z.void()` ceremony:

```typescript
import { defineQuery, defineSignal, defineUpdate } from "@temporal-contract/contract";
import { z } from "zod";

const stop = defineSignal(); // no payload
const getStatus = defineQuery({ output: z.object({ status: z.string() }) });
const refresh = defineUpdate({ output: z.object({ refreshedAt: z.string() }) });
```

Handlers receive `undefined`; client-side, the payload argument becomes
omittable (`handle.queries.getStatus()`).

### Deleted / dropped

- `InferContractWorkflows` (a trivial alias of `TContract["workflows"]`) is
  gone — inline the indexed access.
- The CJS build is gone: `@temporal-contract/contract` is **ESM-only**, like
  the other packages.

## 11. Schedules: typed errors and a fuller surface

Schedule operations now model their anticipated failures instead of routing
everything to the defect channel:

| Operation                                                                              | 8.0 `err` channel                                                                     |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `schedule.create`                                                                      | `WorkflowNotInContractError \| WorkflowValidationError \| ScheduleAlreadyExistsError` |
| handle `pause` / `unpause` / `trigger` / `update` / `backfill` / `delete` / `describe` | `ScheduleNotFoundError`                                                               |

If you matched exhaustively on `schedule.create`'s error union, add a
`ScheduleAlreadyExistsError` arm. The create-if-absent idiom becomes a typed
branch:

```typescript
import { P } from "unthrown";

const created = await orders.schedule.create("reconcileLedger", {
  scheduleId: "nightly-reconcile",
  spec: { cronExpressions: ["0 2 * * *"] },
  args: { mode: "full" },
});

const schedule = created.match({
  ok: (handle) => handle,
  errCases: (matcher) =>
    matcher
      .with(
        P.tag("@temporal-contract/ScheduleAlreadyExistsError"),
        // Already there — bind to it instead.
        () => orders.schedule.getHandle("nightly-reconcile"),
      )
      .with(
        P.tag("@temporal-contract/WorkflowNotInContractError"),
        P.tag("@temporal-contract/WorkflowValidationError"),
        (error) => {
          throw error; // programming errors
        },
      ),
  defect: (cause) => {
    throw cause;
  },
});
```

New on the surface:

- **`schedule.getHandle(scheduleId)`** — bind to an existing schedule.
- **`handle.update(updateFn)`** — fetch-modify-persist the schedule
  definition (Temporal may call `updateFn` more than once on conflict — keep
  it pure).
- **`handle.backfill(options)`** — run the action over historical time
  ranges.
- **`schedule.list(options?)`** — an `AsyncIterable<ScheduleSummary>`
  passthrough of Temporal's `ScheduleClient.list`.

## 12. Second breaking pass (8.0 audit remediation)

A second review before 8.0 stabilised hardened the boundaries, the `unthrown`
integration, and family consistency. These land in the same major.

### Mechanical renames

| 7.x / earlier 8.0 beta                                  | 8.0                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| `SignalNamesOf` / `QueryNamesOf` / `UpdateNamesOf`      | `InferSignalNames` / `InferQueryNames` / `InferUpdateNames` |
| `DeclaredErrorsOf`                                      | `InferDeclaredErrors`                                       |
| `defineActivity({ defaultOptions })`                    | `defineActivity({ activityOptions })`                       |
| `ActivityDefaultOptions` (type)                         | `ContractActivityOptions`                                   |
| `context.defineSignal` / `defineQuery` / `defineUpdate` | `context.handleSignal` / `handleQuery` / `handleUpdate`     |
| `@temporal-contract/contract/result-async`              | removed — internals live at `.../internal` (private)        |

The `Infer*` prefix aligns with amqp-contract; `handle*` frees `define*` for
contract authoring alone (and stops colliding with `@temporalio/workflow`'s
own `defineSignal`).

### `qualifyFailure` triages instead of blanket-wrapping

`expected` is now **required** — an error class, an array of classes, a
predicate, or the explicit literal `"any"`. Causes that match are wrapped into
the modeled `ApplicationFailure`; everything else (a `TypeError` from a bug,
say) rides the **defect** channel instead of being mislabelled a business
error. A matched inner `ApplicationFailure` with `nonRetryable: true` is now
inherited by default.

```diff
- qualifyFailure("CHARGE_FAILED")
+ qualifyFailure("CHARGE_FAILED", { expected: GatewayError })
+ // deliberately keep the old catch-all behaviour, made explicit:
+ qualifyFailure("CHARGE_FAILED", { expected: "any" })
```

### Client: cancellation, termination, timeout, update, and query are modeled

`executeWorkflow` / `handle.result()` gain `WorkflowCancelledError`,
`WorkflowTerminatedError`, `WorkflowTimeoutError` (each keeping the original
`TemporalFailure` as `cause`) instead of burying the outcome in
`WorkflowFailedError.cause`. Update and query failures — `UpdateFailedError`,
`UpdateRejectedError`, `QueryFailedError` — are modeled `Err`s where they
previously leaked as defects. Widen (or, more likely, let the exhaustive
matcher force you to widen) your `result()` / update / query match arms.

Collapse the recurring multi-tag arms with the new bundles and `tagPatterns`:

```typescript
import { tagPatterns, WORKFLOW_RESULT_ERROR_TAGS } from "@temporal-contract/client";

result.match({
  ok: (value) => value,
  errCases: (matcher) =>
    matcher.with(...tagPatterns(WORKFLOW_RESULT_ERROR_TAGS), (error) => report(error)),
  defect: (cause) => report(cause),
});
```

### Cancellation can be swallowed by any activity call

Every activity call now returns an `AsyncResult` — declared `errors` map or
not — so cancelling an in-flight call surfaces as `Err(ActivityCancelledError)`
on every activity, not only ones that declare errors. That is a value a
generic "map every `Err` to a fallback" handler will absorb, completing the
workflow instead of cancelling it. Re-raise with the new
`rethrowCancellation(error)` from `@temporal-contract/worker/workflow`. See
[Handle cancellation](/how-to/handle-cancellation) and [The result
model](/explanation/the-result-model).

### `cancellableScope`/`nonCancellableScope` wrapping an activity call: source break, not just behavior

If a scope's callback returns an activity call directly, this stops
compiling — not just behaves differently:

```ts
// ❌ no longer compiles
const scoped = await context.cancellableScope(() => context.activities.charge(input));
if (scoped.isOk()) {
  scoped.value.transactionId; // scoped.value is now an AsyncResult, not Output
}
```

Both scopes are generic over whatever `fn` returns, verbatim — they do not
await it for you. Before this change, for an activity with **no** declared
`errors` map, `() => context.activities.charge(input)` returned a plain
`Promise<Output>`, so the scope's own `T` was `Output` (an errors-declaring
activity already returned an `AsyncResult` and already had this problem). Now
every activity call returns an `AsyncResult<Output, E>`, and `AsyncResult` is
deliberately not a full `PromiseLike` (no `.catch`/`.finally`), so `T` becomes
the un-awaited `AsyncResult` itself — a type with no `isOk`/`isErr`/`.value`.
Await and narrow the activity call _inside_ the callback instead:

```ts
// ✅ narrow inside the callback
const scoped = await context.cancellableScope(async () => {
  const charged = await context.activities.charge(input);
  if (charged.isDefect()) {
    throw charged.cause;
  }
  if (charged.isErr()) {
    return { ok: false as const, error: charged.error };
  }
  return { ok: true as const, value: charged.value };
});
```

See [Handle cancellation](/how-to/handle-cancellation) for the full pattern,
including cleanup in a `nonCancellableScope`.

### Typed errors carry a wire marker — mind the deploy order

A contract error now crosses the wire with a provenance marker in
`ApplicationFailure.details[1]` (`{ $tc: 1 }`). For an error that declares a
`data` schema, validating `details[0]` is still the gate. For a **data-less**
error the marker is **required** — that closes a false positive where any
unrelated `ApplicationFailure` whose `type` happened to equal a declared
data-less error name was surfaced as the typed domain error.

::: warning Rolling upgrades
The marker is written by 8.0 workers only. During a rolling deploy, a
**data-less** contract error emitted by a still-7.x worker carries no marker,
so an 8.0 workflow or client will not rehydrate it — it degrades to the
generic failure classification. Nothing throws and nothing is logged by
default, so a `match` arm keyed on the typed error silently stops matching for
the duration of the window.

Order the deploy **workers first, then clients/callers**, and drain in-flight
executions before cutting callers over. To make the window observable, register
the diagnostic hook — it fires on every degrade-to-generic:

```typescript
import { onRehydrationMiss } from "@temporal-contract/contract/errors";

onRehydrationMiss((miss) => logger.warn({ miss }, "contract error degraded to generic"));
```

Errors that declare a `data` schema are unaffected: they rehydrate on schema
validation, marker or not.
:::

### Worker: safer declarations

- A shared activity referenced from several scopes must be the **same function
  reference** or hoisted to the global `activities` map — two different
  implementations for one flattened name now throw at declaration (they used to
  silently clobber).
- `TypedWorker.create` **verifies workflow registration** by default: a
  contract workflow missing from the bundle, or an export whose name differs
  from its `workflowName`, fails creation. Opt out with
  `verifyWorkflowRegistration: false`.
- Async query/update schemas are rejected at **bind time** (`ContractMisuseError`),
  not on the first request.
- `ChildWorkflowError` carries a structured `workflowName`; the input/output
  `ValidationError` subclasses carry a `direction: "input" | "output"`.

### Client construction and interceptors

- `ContractClient` and `TypedScheduleClient` are no longer constructible
  directly — obtain them via `typedClient.for(...)` and `client.schedule`.
  `ContractClient` exposes readonly `contract` and `taskQueue` getters, and
  `handle.raw` reaches the underlying `WorkflowHandle`.
- Client interceptor patches may set **only** `input` / `signalInput`; identity
  fields such as `workflowName` are no longer patchable.

### Testing: option bags and a boundary-faithful tier

```diff
- createContractTest(orderContract, { workflowsPath, activities })
+ createContractTest({ contract: orderContract, workflowsPath, activities })

- runActivity(definition, implementation, input)
+ runActivity(definition, { implementation, input })
```

New `runActivityHandler(definition, { ... })` runs the implementation through
the real `declareActivitiesHandler` wrapping (input parse, output validation,
contract-error wire round-trip) so a test fails exactly where production does.
`testcontainers` is now an **optional** peer, needed only for
`createContractTest`.

### Packaging

- Every package is **ESM-only** (client and worker dropped their CJS output and
  legacy `main`/`module`/`types` fields).
- `@temporalio/*` peer ranges tightened to `^1.16.0` (the real floor for the
  Schedule API and the search-attribute imports).

## Checklist

- [ ] All four `@temporal-contract/*` packages on the same 8.0 version
- [ ] `unthrown` resolves to `^5.0.0`
- [ ] `ts-pattern` removed if it was added for beta.5
- [ ] `tag(...)` → `P.tag(...)` if you tracked an earlier 8.0 beta
- [ ] `mapErr` / `flatMapErr` / `tapErr` / `recoverErr` → `*Cases`
- [ ] `match({ err })` → `match({ errCases })`
- [ ] `TypedClient.create` / `TypedWorker.create` use `isDefect()` or `.get()`
- [ ] No `P.tag("@temporal-contract/RuntimeClientError")` or
      `P.tag("@temporal-contract/TechnicalError")` arms remain
- [ ] `TypedClient.create({ contract, client })` →
      `TypedClient.create({ client }).for(contract)`; annotations use
      `ContractClient<typeof c>`; no `createOrThrow`
- [ ] `WorkflowNotFoundError` → `WorkflowNotInContractError` everywhere
      (imports and `P.tag` arms)
- [ ] `getHandle` calls drop their `await` (it returns a sync `Result`)
- [ ] `qualify` → `qualifyFailure` in activity implementations
- [ ] `createWorker(...)` / `createWorkerOrThrow(...)` →
      `TypedWorker.create(...).get()`; `worker.run()` → `worker.run().get()`;
      `runUntil` / `getState` via `worker.raw`
- [ ] No `SignalInputValidationError` imports remain; alerting expects
      invalid signals to be dropped and logged, not to fail executions
- [ ] `schedule.create` matchers handle `ScheduleAlreadyExistsError`;
      schedule-handle matchers handle `ScheduleNotFoundError`
- [ ] No schema relies on its transform running on the send side (each
      boundary now parses once, on receive)
- [ ] `SignalNamesOf` / `QueryNamesOf` / `UpdateNamesOf` / `DeclaredErrorsOf`
      → the `Infer*` prefix; `defineActivity` `defaultOptions` → `activityOptions`;
      the `ActivityDefaultOptions` type → `ContractActivityOptions`
- [ ] `context.defineSignal` / `defineQuery` / `defineUpdate` →
      `handleSignal` / `handleQuery` / `handleUpdate`
- [ ] Every `qualifyFailure(...)` passes `{ expected }` (or `{ expected: "any" }`
      to keep the old catch-all deliberately)
- [ ] `result()` / update / query matchers handle the new modeled errors
      (`WorkflowCancelledError` / `Terminated` / `Timeout`, `UpdateFailedError`,
      `UpdateRejectedError`, `QueryFailedError`)
- [ ] Cancellation isn't swallowed by a declared-error activity —
      `rethrowCancellation` where a generic `Err` fallback would complete the run
- [ ] Shared activities implemented once (same reference or hoisted global)
- [ ] `createContractTest({ contract, ... })` and `runActivity(def, { ... })`
      use the option bag; `testcontainers` installed only where `createContractTest` runs
- [ ] Imports of `@temporal-contract/contract/result-async` removed
- [ ] Rolling deploy ordered **workers before callers**, and `onRehydrationMiss`
      registered — a data-less contract error from a 7.x worker carries no wire
      marker and degrades to a generic failure until the workers are cut over
- [ ] `@temporalio/*` resolve to `^1.16.0`; no CJS `require` of these packages
- [ ] `pnpm typecheck` clean

The exhaustive matcher does most of the work: once it compiles, the migration is
almost certainly complete.

## Also see

- [Migrate from neverthrow](/how-to/migrate-from-neverthrow) — if you are
  coming from a much older release
- [The result model](/explanation/the-result-model) — why the defect channel
  exists
- [Errors reference](/reference/errors)
