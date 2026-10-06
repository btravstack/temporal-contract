# Upgrade from 7.x to 8.0

Version 8 has six headline breaking changes:

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
5. **Every workflow-side activity call returns `AsyncResult`** — declared
   `errors` map or not. A bare `await` that used to throw now silently discards
   the failure.
6. **Workflows declare a `startPolicy`** — the contract, not the call site,
   decides whether a workflow ID may be reused.

Plus a set of smaller renames and semantic fixes, each with its own section
below. Most are mechanical. Budget an afternoon for a medium codebase.

This page describes 7.x → the final 8.0 API. If you already track an 8.0 beta,
read [Upgrade between 8.0 betas](/how-to/upgrade-between-8-betas) instead — it
lists only what changed from one beta to the next.

::: warning 8.0 is currently a prerelease
The 8.0 line is published under the `beta` tag, so a plain
`npm install @temporal-contract/contract` still resolves 7.x. Install
explicitly — see [§1](#_1-bump-the-dependencies).

`unthrown` itself is stable — only the `@temporal-contract/*` packages are on
the `beta` tag.

The [stable docs](https://btravstack.github.io/temporal-contract/) document
7.x; you are reading the beta docs.
:::

## 1. Bump the dependencies

All four packages version together — do not mix. `@temporal-contract/contract`
is now a **peer** of the client and the worker, so install it wherever either
runs:

```bash
pnpm add @temporal-contract/contract@beta \
         @temporal-contract/worker@beta \
         @temporal-contract/client@beta
pnpm add -D @temporal-contract/testing@beta
pnpm add unthrown@^5.11.0
```

Peer floors rise with it: `@temporalio/*` to `^1.24.0` (from `^1`) and
`unthrown` to `^5.11.0` (from `^4.1.0`).

Every package is **ESM-only** — the contract, client, and worker dropped their
CJS output and legacy `main`/`module`/`types` fields. A CommonJS `require` of
them no longer resolves.

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
tags into one branch stays compact. The client exports one ready-made pattern
group per method — `WORKFLOW_START_PATTERNS`, `WORKFLOW_EXECUTE_PATTERNS`,
`WORKFLOW_RESULT_PATTERNS`, `SIGNAL_PATTERNS`, `QUERY_PATTERNS`,
`UPDATE_PATTERNS`, `SCHEDULE_CREATE_PATTERNS`, … — so
`matcher.with(...WORKFLOW_RESULT_PATTERNS, handler)` covers a whole union. A
workflow's own declared contract errors are not in these groups; match them
first (`P.tag(CONTRACT_ERROR_TAG)`, or `{ errorName: "..." }`).

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

// 8.0 — note the contract is gone from `create`; see §5.
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

The same applies to the worker factory — see [§12](#_12-worker-renames-and-stricter-declaration-checks).

### Every other operation

`RuntimeClientError` is gone from the error union of `startWorkflow`,
`signalWithStart`, `executeWorkflow`, the handle's `queries` / `signals` /
`updates` / `result` / `terminate` / `cancel` / `describe` / `fetchHistory`,
and the schedule handle methods.

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

See [§7](#_7-schedules-typed-errors-and-a-fuller-surface) for the full 8.0
schedule surface.

::: warning A bare `await` swallows the failure
`AsyncResult` is a success-only thenable: awaiting it collapses it to a
`Result`, and the underlying promise never rejects. `await schedule.pause(...)`
on its own discards the outcome — the modeled `ScheduleNotFoundError` (an `Err`,
not a defect) included. Chain `.getOrThrow()`, or branch on `isErr()`.
:::

## 5. Split the client: `create` then `for`

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
| `create({ ..., interceptors })`                    | removed — see below                            |

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
`ContractClient` is not constructible directly; it exposes readonly `contract`
and `taskQueue` getters.

While migrating, a stray 7.x-style `TypedClient<typeof x>` annotation fails
loudly — `TypedClient` no longer takes a type argument.

### Client interceptors are gone

`interceptors`, `ClientInterceptor`, `ClientInterceptorArgs`,
`ClientInterceptorNext`, and `ClientCallError` are no longer exported. Every
client method already returns an `AsyncResult`, so wrap the call site with the
combinators (`tapErrCases`, `recoverDefect`, `map`) or your own function.

### `WorkflowNotFoundError` is gone

It meant "the name is not on the contract" — a programming error, not an
anticipated outcome. The types only admit declared workflow, signal, and update
names, so a name that slips past them (a cast, an untyped caller) is now a
**defect** carrying a `TechnicalError`. Delete the class's imports and every
`P.tag("@temporal-contract/WorkflowNotFoundError")` arm.

`WorkflowExecutionNotFoundError` (the _execution_ does not exist on the
server) is unchanged.

### `getHandle` returns the handle

Contract lookup needs no I/O, so `getHandle` is synchronous and infallible, like
Temporal's own: it returns the typed handle directly. Whether the execution
exists is answered lazily by the handle's methods
(`WorkflowExecutionNotFoundError`). It also accepts an options object: `runId`
(bind a specific execution) and Temporal's `firstExecutionRunId`.

```typescript
// 7.x
const bound = await typedClient.getHandle("processOrder", "order-123");

// 8.0
const handle = orders.getHandle("processOrder", "order-123");
const pinned = orders.getHandle("processOrder", "order-123", { runId });
```

### The contract owns the start options

`startWorkflow` / `signalWithStart` / `executeWorkflow` no longer accept
`workflowIdReusePolicy` (the contract's `startPolicy` decides it — see
[§10](#_10-workflows-declare-startpolicy)) or `followRuns` (handles always
follow the run chain, so `result()` resolves to the final run's outcome after a
continue-as-new). Delete both options.

A handle returned by a start has `runId: undefined` for the same reason; read
`firstExecutionRunId` for the run that was started.

### Deleted type exports

Six unused `ClientInfer*` aliases are gone: `ClientInferWorkflow`,
`ClientInferActivity`, `ClientInferWorkflows`, `ClientInferActivities`,
`ClientInferWorkflowActivities`, `ClientInferWorkflowContextActivities`.
Still exported: `ClientInferInput`, `ClientInferOutput`, `ClientInferSignal`,
`ClientInferQuery`, `ClientInferUpdate`, `ClientInferWorkflowSignals`,
`ClientInferWorkflowQueries`, `ClientInferWorkflowUpdates`.

### New surface worth adopting

Not breaking, but part of the same overhaul:

- **`typedClient.raw`** / **`handle.raw`** — the underlying `@temporalio/client`
  `Client` / `WorkflowHandle`, for anything the typed surface does not cover
  (`raw.workflow.list(...)`). Bypasses validation.
- **`handle.startUpdate(name, options)`** — start an update without waiting
  for its result; returns a `TypedWorkflowUpdateHandle` whose `result()`
  parses the outcome. `handle.getUpdateHandle(name, updateId)` reattaches to
  one, and `handle.updates.name(input, { updateId })` passes an update ID.
- **`executeUpdateWithStart(workflowName, { ..., workflowIdConflictPolicy, updateName, updateArgs })`**
  — Temporal's update-with-start, validated on both payloads.
- **`workflowIdFor(workflowName, input)`** — the ID a contract derives for an
  input (see [§10](#let-the-contract-derive-the-workflow-id)), to `getHandle`
  it later.
- **`TypedClient.create({ client, onRehydrationMiss })`** — a hook fired when a
  failure named like a declared error fails to rehydrate into it (see
  [§9](#typed-errors-carry-a-wire-marker-—-mind-the-deploy-order)).
- **`WorkflowValidationError.workflowId`** and **`WorkflowFailedError.retryState`**.
- **Omittable payloads** — for a signal/query/update whose input schema
  accepts `undefined` (see [§9](#input-less-signals-queries-and-updates)), the
  client-side payload argument is optional: `handle.queries.getStatus()`.

## 6. Client: workflow, update, and query outcomes are modeled

`executeWorkflow` / `handle.result()` gain `WorkflowCancelledError`,
`WorkflowTerminatedError`, `WorkflowTimeoutError` (each keeping the original
`TemporalFailure` as `cause`) instead of burying the outcome in
`WorkflowFailedError.cause`. Update and query failures — `UpdateFailedError`,
`UpdateRejectedError`, `UpdateRpcTimeoutOrCancelledError`, `QueryFailedError` —
are modeled `Err`s. Widen (or, more likely, let the exhaustive matcher force you
to widen) your `result()` / update / query match arms:

```typescript
import { WORKFLOW_RESULT_PATTERNS } from "@temporal-contract/client";

result.match({
  ok: (value) => value,
  errCases: (matcher) => matcher.with(...WORKFLOW_RESULT_PATTERNS, (error) => report(error)),
  defect: (cause) => report(cause),
});
```

`startUpdate` errs only with `UpdateValidationError`,
`UpdateRpcTimeoutOrCancelledError`, or `WorkflowExecutionNotFoundError`: a
rejected update or a failed handler surfaces on the update handle's `result()`.

## 7. Schedules: typed errors and a fuller surface

Schedule operations now model their anticipated failures instead of routing
everything to the defect channel:

| Operation                                                                   | 8.0 `err` channel                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------- |
| `schedule.create`                                                           | `WorkflowValidationError \| ScheduleAlreadyExistsError` |
| handle `pause` / `unpause` / `trigger` / `backfill` / `delete` / `describe` | `ScheduleNotFoundError`                                 |
| handle `update`                                                             | `ScheduleNotFoundError \| WorkflowValidationError`      |

If you matched exhaustively on `schedule.create`'s error union, drop the
`WorkflowNotFoundError` arm and add a `ScheduleAlreadyExistsError` one. The
create-if-absent idiom becomes a typed branch:

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
      .with(P.tag("@temporal-contract/WorkflowValidationError"), (error) => {
        throw error; // a programming error
      }),
  defect: (cause) => {
    throw cause;
  },
});
```

New on the surface:

- **`schedule.getHandle(scheduleId)`** — bind to an existing schedule.
- **`handle.update(updateFn)`** — fetch-modify-persist the schedule
  definition. A contract workflow's `args` and search attributes are
  re-checked before anything is persisted. Last writer wins: Temporal's update
  is unconditional, so serialize concurrent writers yourself.
- **`handle.backfill(options)`** — run the action over historical time
  ranges.
- **`handle.raw`** — the SDK's `ScheduleHandle`.
- **`schedule.list(options?)`** — an `AsyncIterable<ScheduleSummary>`
  passthrough of Temporal's `ScheduleClient.list`.

`args` is optional on `schedule.create` when the workflow's input schema
accepts `undefined`.

## 8. Wire format: each boundary parses exactly once

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

### Validation messages name paths only

`summarizeIssues` — and so the `message` of every client and worker validation
error — lists the failing paths only, capped at five
(`at email; at items[0].qty; …and 3 more`), where 7.x printed
`at path: <schema message>`. A worker validation error's message becomes the
`ApplicationFailure` message in Temporal history, which payload codecs do not
encrypt, and schema messages embed raw input values. Read `error.issues` for
the detail (worker validation failures also carry them in `details[0]`, which
codecs do encrypt), and update any assertion on the old message text.

### Invalid signals are dropped, not fatal

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

## 9. Contract package changes

### Renames

| 7.x                                                | 8.0                                                         |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `SignalNamesOf` / `QueryNamesOf` / `UpdateNamesOf` | `InferSignalNames` / `InferQueryNames` / `InferUpdateNames` |
| `DeclaredErrorsOf`                                 | `InferDeclaredErrors`                                       |
| `defineActivity({ defaultOptions })`               | `defineActivity({ activityOptions })`                       |
| `ActivityDefaultOptions` (type)                    | `ContractActivityOptions`                                   |
| `@temporal-contract/contract/result-async`         | removed — internals live at `.../internal` (private)        |
| `InferContractWorkflows`                           | removed — inline `TContract["workflows"]`                   |

### Stricter validation, without zod

`defineContract`'s structural validation is now hand-rolled — **zod is gone
from the contract package's runtime dependencies** (your schemas can of course
still be zod). It rejects much more up front, and throws a
`ContractDefinitionError` (exported; a plain `Error` subclass whose `path`
names the offending slot, e.g. `workflows.processOrder.signals.cancel`) instead
of a bare `Error`. Newly rejected:

- an unknown key on the contract root or on any workflow, activity, signal,
  query, update, error, or search-attribute definition — a leftover
  `defaultOptions` gets a rename hint;
- a workflow without a valid `startPolicy` (see [§10](#_10-workflows-declare-startpolicy));
- a `taskQueue` with leading/trailing whitespace or over 1000 characters;
- a name Temporal reserves (`__temporal_*`, `__stack_trace`,
  `__enhanced_stack_trace`), an `Object.prototype` member (`constructor`, …),
  an error name the worker uses for its own failures, or a search attribute
  named like a Temporal system attribute (`WorkflowId`, …) or declared with
  two kinds across workflows;
- an `activityOptions` duration that is not a valid `ms` string
  (`"5 minutos"`), or a retry policy Temporal would reject.

Match on `instanceof ContractDefinitionError` rather than the message text. See
[Define a contract](/how-to/define-a-contract#what-definecontract-checks) for
the full list.

### Activity-name collisions, recalibrated

- **Sharing the same activity object** across workflows is now allowed —
  reference equality means it is one activity, not a collision.
- Two _different_ definitions under the same name is still an error, and the
  message now recommends hoisting the shared activity to the contract's
  global `activities` block.
- A **workflow name colliding with a global activity name** is now rejected —
  they share the root of the worker's implementations map.
- **Activity-only contracts** are allowed: `workflows` may be `{}` when at
  least one global activity is declared.

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
generic failure classification, and a `match` arm keyed on the typed error
silently stops matching for the duration of the window.

Order the deploy **workers first, then clients/callers**, and drain in-flight
executions before cutting callers over. The degrades are observable: the
worker logs each one through the workflow logger (`log.warn`), and the client
reports them to `TypedClient.create({ client, onRehydrationMiss })`.

Errors that declare a `data` schema are unaffected: they rehydrate on schema
validation, marker or not.
:::

## 10. Workflows declare `startPolicy`

Every `defineWorkflow` now takes a required `startPolicy` field — enforced by
TypeScript and by `defineContract` at runtime. There is no default to inherit.

Temporal's `workflowIdReusePolicy` defaults to `ALLOW_DUPLICATE`, which
permits starting a new run under a workflow ID whose previous run reached
**any** Closed state — including Completed. For a workflow keyed
`charge-${orderId}`, a client that retries a start after, say, a network
timeout — not knowing the first attempt actually went through — starts a
**second** charge under the same order ID. `startPolicy` makes the answer to
"is this safe?" part of the workflow's own definition instead of something
every call site has to get right on its own:

```typescript
defineWorkflow({
  input,
  output,
  startPolicy: "retry-if-failed", // re-runnable only if the last attempt didn't succeed
});
```

| `WorkflowStartPolicy` | Temporal policy               | Meaning                                                                                                                            |
| --------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `"once-per-id"`       | `REJECT_DUPLICATE`            | This workflow ID may run exactly once, ever.                                                                                       |
| `"retry-if-failed"`   | `ALLOW_DUPLICATE_FAILED_ONLY` | Re-runnable only if the previous run reached a Closed state **other than Completed** — Failed, Cancelled, Terminated, or TimedOut. |
| `"allow-duplicate"`   | `ALLOW_DUPLICATE`             | Temporal's own default — unconditionally re-runnable after any Closed run.                                                         |

The client applies the policy to every `startWorkflow` / `executeWorkflow` /
`signalWithStart`, and the worker applies it to every
`context.startChildWorkflow` / `context.executeChildWorkflow` of that
workflow. There is no per-call `workflowIdReusePolicy` override on either side.
`workflowIdConflictPolicy` — what to do about a run that is already _open_, as
opposed to closed — is untouched: it stays a per-call option, because that
answer legitimately differs by caller, while the reuse question does not.

**If you want zero behavior change, use `"allow-duplicate"` everywhere** —
that is exactly Temporal's default, reproduced faithfully. Treat a sweep of
`startPolicy: "allow-duplicate"` as a placeholder to revisit workflow by
workflow, not as the final answer. A call site that passed its own
`workflowIdReusePolicy` in 7.x now needs that policy on the contract instead.

`startPolicy` does **not** make a workflow idempotent. For an activity
re-running under Temporal's at-least-once guarantee, see
[an activity's `idempotencyKey`](/how-to/implement-activities).

### Let the contract derive the workflow ID

`startPolicy` only bites if two starts of the same logical request actually
collide on one workflow ID — and in 7.x the ID was entirely the caller's:

```typescript
// compiles, and silently makes `once-per-id` inert: every start is a fresh ID
orders.startWorkflow("processOrder", { workflowId: crypto.randomUUID(), args: order });
```

Declare `workflowId` on the workflow and the ID moves into the contract.
Passing one at the call site then becomes a **type error** — on
`startWorkflow`, `executeWorkflow`, `signalWithStart`, and child-workflow
calls — so the policy and the thing it keys on can no longer disagree:

```typescript
const processOrder = defineWorkflow({
  input: OrderSchema,
  output: OrderResultSchema,
  workflowId: ({ orderId }) => `order-${orderId}`,
  startPolicy: "once-per-id",
});

// ID derived from the payload — no `workflowId` accepted here
await orders.startWorkflow("processOrder", { args: order });
```

The derivation runs against the **validated** input (post-parse, so schema
transforms have already applied) and must be pure. It is optional: a workflow
that declares none keeps requiring `workflowId` from the caller.
`orders.workflowIdFor("processOrder", order)` returns the derived ID.

Not applied to `schedule.create`, which generates one ID per firing — a
scheduled run wants a distinct execution, not deduplication.

## 11. Every activity call returns `AsyncResult`

In 7.x the call convention depended on whether the contract declared an
`errors` map: activities with declared errors returned `AsyncResult`, those
without returned a plain `Promise<Output>` that threw. In 8.0, every activity
call — declared errors or not — returns `AsyncResult<Output, E>`, and the
throwing wrapper is gone.

::: danger The most dangerous hazard of the upgrade, and the compiler will not catch it
`await context.activities.sendEmail(input);` compiles **identically** before
and after this change. In 7.x, that line still threw on failure, so the
workflow failed. In 8.0, it discards the `AsyncResult` — the failure is
silently swallowed and the workflow proceeds as if the call succeeded.
TypeScript gives no warning: `AsyncResult` is a valid, `await`-able value
either way.
:::

Audit every activity call site and choose one of two shapes:

```ts
// Narrow it — the workflow branches on the outcome itself.
const result = await context.activities.sendEmail(input);
if (result.isErr()) {
  /* ... */
}

// Or propagate it — let a failure escape and have Temporal decide the
// workflow's fate, matching the 7.x "just let it throw" behavior.
import { propagateFailure } from "@temporal-contract/worker/workflow";

await propagateFailure(context.activities.sendEmail(input));
```

`propagateFailure` re-raises the original Temporal failure, exactly what would
have escaped the workflow in 7.x. It also covers child-workflow calls and
cancellation scopes. Its counterpart, `bestEffort(result, onFailure)`, covers a
call whose failure is worth a warning rather than the workflow.

Prefer `propagateFailure` to unthrown's `.getOrThrow()` / `throw result.error`:
those throw the `ActivityError` / `ActivityCancelledError` wrapper, a
`TaggedError` rather than a `TemporalFailure`. `declareWorkflow` (and signal and
update handlers) map such a throw to the Temporal failure it carries, but
anything that catches it in between — a `try`, a library — sees the wrapper,
not the failure. See [The result model](/explanation/the-result-model).

A bare `await` that discards the result is easy to introduce by habit. Grep for
`await context.activities.` (or your local alias) and confirm each hit either
narrows the result or passes it through `propagateFailure` — an un-narrowed,
un-propagated `AsyncResult` sitting in an expression statement is the tell.

### Cancellation can be swallowed by any activity call

Cancelling an in-flight call surfaces as `Err(ActivityCancelledError)` on every
activity, not only ones that declare errors. That is a value a generic "map
every `Err` to a fallback" handler will absorb, completing the workflow instead
of cancelling it. Re-raise with `rethrowCancellation(error)` from
`@temporal-contract/worker/workflow`, or use `bestEffort`, which re-raises
cancellation for you. See [Handle cancellation](/how-to/handle-cancellation).

### A cancellation scope wrapping an activity call: source break

`cancellableScope` / `nonCancellableScope` await what `fn` returns and resolve
to it. In 7.x, `() => context.activities.charge(input)` for an activity with
**no** declared `errors` map returned a `Promise<Output>`, so the scope's value
was `Output`. It now returns an `AsyncResult`, so the scope's value is that
activity's settled `Result` — nested inside the scope's own:

```ts
// ❌ no longer compiles
const scoped = await context.cancellableScope(() => context.activities.charge(input));
if (scoped.isOk()) {
  scoped.value.transactionId; // scoped.value is a Result, not Output
}

// ✅ unwrap inside the callback
const scoped = await context.cancellableScope(() =>
  propagateFailure(context.activities.charge(input)),
);
```

See [Handle cancellation](/how-to/handle-cancellation) for the full pattern,
including cleanup in a `nonCancellableScope`.

## 12. Worker: renames and stricter declaration checks

### Renames

| 7.x                                                     | 8.0                                                     |
| ------------------------------------------------------- | ------------------------------------------------------- |
| `createWorker(options)`                                 | `TypedWorker.create(options)`                           |
| `createWorkerOrThrow(options)`                          | removed — `TypedWorker.create(options).get()`           |
| `qualify("X")`                                          | `qualifyFailure("X", { expected })`                     |
| `defineActivityMiddleware`                              | `declareActivityMiddleware`                             |
| `context.defineSignal` / `defineQuery` / `defineUpdate` | `context.handleSignal` / `handleQuery` / `handleUpdate` |

`define*` is reserved for contract authoring; implementation-side APIs are
`declare*` / `handle*` (which also stops colliding with `@temporalio/workflow`'s
own `defineSignal`).

### `createWorker` → `TypedWorker.create`

The free function is replaced by a static factory on a `TypedWorker` class —
the worker-side sibling of `TypedClient.create`. It takes the same options and
returns `AsyncResult<TypedWorker, never>`; the underlying Temporal `Worker`
stays reachable as `worker.raw`.

```diff
- import { createWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";
+ import { TypedWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";

- const worker = await createWorker({ contract, connection, workflowsPath, activities }).get();
+ const worker = await TypedWorker.create({ contract, connection, workflowsPath, activities }).get();

- await worker.run();
+ await worker.run().get();
```

`worker.run()` returns `AsyncResult<void, never>` — a worker that fails while
running is a defect (a `TechnicalError` cause), and the underlying promise never
rejects. `worker.shutdown()` returns `Result<void, never>` (calling it on a
worker that is not running is a defect). Anything else Temporal offers
(`runUntil`, `getState`) lives on `worker.raw`.

`TypedWorker.create` also **verifies workflow registration** by default: a
contract workflow missing from the `workflowsPath` module, an export whose name
differs from its `workflowName`, or a `declareWorkflow` that throws
`ContractMisuseError` at import fails creation. Opt out with
`verifyWorkflowRegistration: false`.

### `qualifyFailure` triages instead of blanket-wrapping

`qualify` blanket-wrapped every rejection. `qualifyFailure` takes a required
`expected` discriminator — an error class, an array of classes, a predicate, or
the explicit literal `"any"`. Causes that match are wrapped into the modeled
`ApplicationFailure`; everything else (a `TypeError` from a bug, say) rides the
**defect** channel instead of being mislabelled a business error. A matched
inner `ApplicationFailure` with `nonRetryable: true` is inherited by default,
and a cancellation is never wrapped.

```diff
- import { declareActivitiesHandler, qualify } from "@temporal-contract/worker/activity";
+ import { declareActivitiesHandler, qualifyFailure } from "@temporal-contract/worker/activity";

-       fromPromise(gateway.charge(customerId, amount), qualify("CHARGE_FAILED"))
+       fromPromise(gateway.charge(customerId, amount), qualifyFailure("CHARGE_FAILED", { expected: GatewayError }))
+       // or keep the old catch-all, made explicit: { expected: "any" }
```

### Contract misuse fails the execution instead of hanging it

Binding a signal/query/update handler for a name the contract does not
declare, throwing an undeclared `ContractError`, or continuing as new into a
workflow not on the contract used to throw a plain `Error` (or a misleading
validation error) inside the workflow sandbox — which Temporal treats as a
Workflow Task failure and retries **forever**, leaving the execution silently
`Running`.

8.0 throws `ContractMisuseError` (a non-retryable `ApplicationFailure`,
exported from `./workflow` and `./activity`) at these sites. They run inside
your `implementation`, so the throw fails the execution terminally with a clear
message, the same way `throw context.errors.X(...)` does. If you monitored for
stuck executions caused by these bugs, they now surface as failed executions
instead. A query or update input schema that validates asynchronously (Temporal
runs those slots synchronously) trips it too, rejecting that query or update.
`declareActivitiesHandler`'s missing, conflicting, or ambiguous implementations
throw it as well.

An unbounded activity is different — see [§13](#_13-activity-bounds-and-required-parentclosepolicy).

### Declarations fail fast

- `declareActivitiesHandler` iterates the contract's **definitions**: a
  declared activity with no implementation throws at declaration time, and a
  stray key throws `ActivityDefinitionNotFoundError`.
- A shared activity referenced from several scopes must be the **same function
  reference** or hoisted to the global `activities` map — two different
  implementations for one flattened name now throw (they used to silently
  clobber).
- `ChildWorkflowError` carries a structured `workflowName`; the input/output
  `ValidationError` subclasses carry a `direction: "input" | "output"`.

### Workflow-only workers

`activities` is now optional on `TypedWorker.create`. Omit it and the worker
only polls for Workflow Tasks — the split-deployment pattern where workflow and
activity workers scale independently on the same task queue. Relatedly, a
workflow that declares no activities no longer needs an empty `{}` entry in the
`declareActivitiesHandler` map.

### Typed child workflows grew

`TypedChildWorkflowHandle` carries `firstExecutionRunId` and a typed `signals`
map — one sender per signal the child declares, validated on send and parsed by
the child on receive. A child's declared `errors` rehydrate into typed
`ContractError`s on `executeChildWorkflow` / `handle.result()`
(`ChildWorkflowContractErrorsOf`), so handle those members alongside
`ChildWorkflowError`. `workflowIdReusePolicy` is no longer a child option — the
child's `startPolicy` owns it.

```typescript
const started = await context.startChildWorkflow(orderContract, "collectPayment", {
  workflowId: `payment-${order.orderId}`,
  args: { customerId: order.customerId, amount: order.total },
  parentClosePolicy: "TERMINATE",
});

if (started.isOk()) {
  await started.value.signals.applyDiscount({ percent: 10 });
}
```

## 13. Activity bounds and required `parentClosePolicy`

Two more safety requirements are enforced instead of assumed —
`parentClosePolicy` at compile time via TypeScript, activity bounds at
`declareWorkflow` time via a `ContractMisuseError`.

### Every reachable activity needs a per-attempt bound and a total bound

7.x never checked the **merged** activity options. That let combinations
through with no effective timeout at all: a contract-level `retry` block with
no timeout, any truthy `activityOptions` on `declareWorkflow` (which skipped the
check for every activity, including `{}`), and — regardless of source — a
`retry.maximumAttempts` left at its default `Infinity`, which bounds nothing.

8.0 checks the merge (`declareWorkflow`'s `activityOptions` → the contract's
`defineActivity({ activityOptions })` → `activityOptionsByName`, shallow —
a later layer's `retry` block replaces an earlier layer's entirely) for
**every** reachable activity, unconditionally. A violation throws
`ContractMisuseError` naming every offender and the rule each one broke:

```
declareWorkflow: every reachable activity needs a total bound, so a failing activity
cannot retry forever. These do not:
  - chargePayment: missing a total bound (set `scheduleToCloseTimeout`, or a finite positive `retry.maximumAttempts`)
Options are merged from `declareWorkflow`'s `activityOptions`, the contract's
`defineActivity({ activityOptions })`, and `activityOptionsByName`. That merge is
shallow, so a later layer's `retry` replaces an earlier layer's entirely — check the
merged result, not each layer.
```

**Fix:** give the merged result for the named activity/activities either
`scheduleToCloseTimeout` (which satisfies both rules on its own) or both
`startToCloseTimeout` **and** a finite positive `retry.maximumAttempts`:

```diff
  export const processOrder = declareWorkflow({
    workflowName: "processOrder",
    contract: orderContract,
-   activityOptions: { startToCloseTimeout: "1 minute" },
+   activityOptions: { startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3 } },
    implementation: async (context, args) => { ... },
  });
```

Watch the shallow-merge trap specifically: if a contract-level
`defineActivity({ activityOptions: { retry: { initialInterval: "2s" } } })`
wins the merge for an activity, it replaces the workflow-wide `retry` block
**entirely**, silently dropping a `maximumAttempts` the workflow-wide default
supplied. Both layers look bounded in isolation; only the merged result
reveals the drop.

**Where a violation surfaces.** `declareWorkflow` runs at module top level, so
the throw happens while the workflows module is evaluated, before the SDK
invokes the workflow function. `TypedWorker.create`'s registration check
imports that module, so with `workflowsPath` and the default
`verifyWorkflowRegistration` the **worker fails to start**. Inside the sandbox
(a prebuilt `workflowBundle`, or the check turned off) the same throw is a
Workflow **Task** failure that `nonRetryable` cannot change: it **stalls** the
workflow via indefinite workflow-task retry rather than failing it. That is
deliberate — a fix-and-redeploy resumes in-flight executions, where a terminal
failure would kill every one of them, mid-payment included.

### `parentClosePolicy` is now required on every child workflow call

`context.startChildWorkflow` / `context.executeChildWorkflow` previously let
`parentClosePolicy` fall through to Temporal's own default (`TERMINATE`,
kill the child when the parent closes) silently. 8.0 makes it a required
field on `TypedChildWorkflowOptions`, and rejects an explicit `undefined` too:

```
Property 'parentClosePolicy' is missing in type '{ workflowId: string; args: { ... }; }' but required in
type '{ args: { ... }; parentClosePolicy: "REQUEST_CANCEL" | "TERMINATE" | "ABANDON"; }'.
```

**Fix:** add the field. `"TERMINATE"` reproduces the exact previous
behavior — nothing about how the child actually behaves changes, only
whether the choice is written down:

```diff
  const childResult = await context.executeChildWorkflow(orderContract, "collectPayment", {
    workflowId: `payment-${order.orderId}`,
    args: { customerId: order.customerId, amount: order.total },
+   parentClosePolicy: "TERMINATE",
  });
```

Use this as a prompt to actually decide, per call site, rather than a
mechanical fill-in: `REQUEST_CANCEL` if the child needs to compensate before
exiting (e.g. release a hold, refund a partial charge), `ABANDON` for
fire-and-forget work that should outlive its parent.

## 14. The activity leaf takes one record

An activity implementation now receives **one record carrying everything the
invocation has** — `errors`, `context` and the validated `input` — with that
input repeated as a second positional parameter. That is oRPC's shape, down to
its word for the input, and therefore the one this family converged on
(`@amqp-contract` moved with it).

```diff
  export const activities = declareActivitiesHandler({
    contract: orderContract,
    activities: {
-     sendNotification: ({ customerId, message }) => ...,
+     sendNotification: ({ input: { customerId, message } }) => ...,
      processOrder: {
-       chargeCard: ({ customerId, amount }, { errors }) => ...,
+       chargeCard: ({ errors, input: { customerId, amount } }) => ...,
      },
    },
  });
```

`({ errors }, args) => ...` remains the same call for anyone who prefers it; the
record is the spelling that does not need a `_` placeholder when the
implementation wants only its input. `ActivityImplementationFor` /
`GlobalActivityImplementationFor` annotations carry the same order.

**The compiler catches every site that READS its input**, since the first
parameter is the record now — and misses the ones that ignore it, where the
swap is harmless but the parameter name lies. Grep the implementations map for a
leaf whose first parameter is not a record destructuring: anything else still
names the input.

## 15. Testing

The 7.x entry points (`./extension`, `./global-setup`, `./time-skipping`) keep
working. `@temporal-contract/testing` now peer-depends on the contract, client,
and worker packages and on `unthrown` (`^5.11.0`), raises its
`@temporalio/client` / `@temporalio/worker` floors to `^1.24.0`, and makes
`@temporalio/testing` (`^1.24.0`, needed by `/activity`, `/time-skipping`,
`/test-rig`), `vitest` (`^4 || ^5`, needed by every entry except `/activity`
and `/workflow-bundle`), and `testcontainers` (`/global-setup`) optional peers.

It adds contract-aware helpers — `createContractTest` (each call in its own
Temporal namespace), `createTimeSkippingContractTest`, `runActivity` /
`runActivityHandler`, `testRig`, and the `/workflow-bundle` helpers. The
global setup now pins its default images by digest and gives PostgreSQL a
random password and no host port. See [Test workflows](/how-to/test-workflows).

## Checklist

- [ ] All four `@temporal-contract/*` packages on the same 8.0 version;
      `@temporal-contract/contract` installed wherever the client or worker runs
- [ ] `unthrown` resolves to `^5.11.0`, `@temporalio/*` (`@temporalio/testing`
      included) to `^1.24.0`; no CJS `require` of these packages
- [ ] `mapErr` / `flatMapErr` / `tapErr` / `recoverErr` → `*Cases`
- [ ] `match({ err })` → `match({ errCases })`
- [ ] `TypedClient.create` / `TypedWorker.create` use `isDefect()` or `.get()`
- [ ] No `P.tag("@temporal-contract/RuntimeClientError")` or
      `P.tag("@temporal-contract/TechnicalError")` arms remain
- [ ] `TypedClient.create({ contract, client })` →
      `TypedClient.create({ client }).for(contract)`; annotations use
      `ContractClient<typeof c>`; no `createOrThrow`, no `interceptors`
- [ ] No `WorkflowNotFoundError` imports or arms remain
- [ ] `getHandle` calls drop their `await` and use the handle directly
- [ ] No `workflowIdReusePolicy` / `followRuns` on start calls or child calls
- [ ] `result()` / update / query matchers handle the new modeled errors
      (`WorkflowCancelledError` / `Terminated` / `Timeout`, `UpdateFailedError`,
      `UpdateRejectedError`, `UpdateRpcTimeoutOrCancelledError`, `QueryFailedError`)
- [ ] `schedule.create` matchers handle `ScheduleAlreadyExistsError`;
      schedule-handle matchers handle `ScheduleNotFoundError`
- [ ] No schema relies on its transform running on the send side
- [ ] No assertion matches the old `at path: <schema message>` validation text
- [ ] No `SignalInputValidationError` imports remain; alerting expects
      invalid signals to be dropped and logged, not to fail executions
- [ ] `SignalNamesOf` / `QueryNamesOf` / `UpdateNamesOf` / `DeclaredErrorsOf`
      → the `Infer*` prefix; `defineActivity` `defaultOptions` → `activityOptions`;
      `ActivityDefaultOptions` → `ContractActivityOptions`
- [ ] Imports of `@temporal-contract/contract/result-async` removed
- [ ] Rolling deploy ordered **workers before callers**, with the worker's
      `log.warn` output watched
- [ ] Every `defineWorkflow` declares `startPolicy`; a migration wanting zero
      behavior change uses `"allow-duplicate"` everywhere, then revisits each
      workflow deliberately
- [ ] Every `await context.activities.x(...)` either narrows the `AsyncResult`
      or is wrapped in `propagateFailure`
- [ ] Cancellation isn't swallowed by any activity call — `rethrowCancellation`
      or `bestEffort` where a generic `Err` fallback would complete the run
- [ ] `createWorker(...)` / `createWorkerOrThrow(...)` →
      `TypedWorker.create(...).get()`; `worker.run()` → `worker.run().get()`;
      `runUntil` / `getState` via `worker.raw`
- [ ] `qualify` → `qualifyFailure(..., { expected })`
- [ ] `defineActivityMiddleware` → `declareActivityMiddleware`;
      `context.defineSignal` / `defineQuery` / `defineUpdate` →
      `handleSignal` / `handleQuery` / `handleUpdate`
- [ ] Shared activities implemented once (same reference or hoisted global)
- [ ] Every reachable activity's MERGED options carry a per-attempt bound and a
      total bound
- [ ] Every child workflow call states `parentClosePolicy` explicitly
- [ ] Every activity implementation takes the helpers record first — a leaf
      that reads its input reads `({ input }) => ...`
- [ ] `pnpm typecheck` clean

The exhaustive matcher does most of the work: once it compiles, the migration is
almost certainly complete.

## Also see

- [Upgrade between 8.0 betas](/how-to/upgrade-between-8-betas) — if you
  already track an 8.0 beta
- [Migrate from neverthrow](/how-to/migrate-from-neverthrow) — if you are
  coming from a much older release
- [The result model](/explanation/the-result-model) — why the defect channel
  exists
- [Errors reference](/reference/errors)
