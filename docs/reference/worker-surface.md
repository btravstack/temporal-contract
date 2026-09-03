# Worker surface

`@temporal-contract/worker` has three entry points and no root export. The split
is deliberate: workflow code is bundled into Temporal's deterministic sandbox
and must not pull in activity or worker dependencies.

| Entry point                          | Runs in                      |
| ------------------------------------ | ---------------------------- |
| `@temporal-contract/worker/activity` | The activity worker          |
| `@temporal-contract/worker/workflow` | The bundled workflow sandbox |
| `@temporal-contract/worker/worker`   | Process setup                |

Generated per-symbol docs: [API reference](/api/worker/).

## `@temporal-contract/worker/workflow`

### `declareWorkflow(options)`

```typescript
function declareWorkflow<TContract, TWorkflowName>(
  options: DeclareWorkflowOptions<TContract, TWorkflowName>,
): (...args: unknown[]) => Promise<Output>;
```

| Option                  | Type                                    | Required    |
| ----------------------- | --------------------------------------- | ----------- |
| `workflowName`          | key of `contract.workflows`             | yes         |
| `contract`              | `ContractDefinition`                    | yes         |
| `implementation`        | `(context, args) => Promise<Output>`    | yes         |
| `activityOptions`       | `ActivityOptions`                       | conditional |
| `activityOptionsByName` | `Record<ActivityName, ActivityOptions>` | no          |

`activityOptions` may be omitted only if every reachable activity's bounds
(see "Activity bounds" below) are fully covered by a contract-level
`defineActivity({ activityOptions })` or an `activityOptionsByName` entry.
Otherwise `declareWorkflow` throws at declaration time, naming the uncovered
activities and the rule each one breaks. An unknown `workflowName` also fails
at declaration time (a `ContractMisuseError`), listing the contract's
available workflow names.

`DeclareWorkflowOptions<TContract, TWorkflowName>` and
`WorkflowImplementation<TContract, TWorkflowName>` — the option-bag and the
`(context, args) => Promise<Output>` implementation shape — are exported so a
workflow can be declared or annotated standalone.

The returned function carries `name === workflowName`, which is how Temporal
derives the workflow type.

Workflow input is **parsed on receive** here — the client validated the args
but transmitted the caller's original value, so a transforming schema applies
exactly once. The return value is validated before completion and transmitted
as-is; the client parses it on receive. See
[Validation boundaries](/explanation/validation-boundaries).

### Activity bounds

Every activity reachable from a workflow (workflow-local + global) must end
up, in its **merged** options, with both of these:

- **A per-attempt bound** — `startToCloseTimeout` or `scheduleToCloseTimeout`,
  present. Caps how long a single attempt may run.
- **A total bound** — `scheduleToCloseTimeout`, or `retry.maximumAttempts` as
  a finite positive integer. Caps how long the whole retry sequence may run.

`scheduleToCloseTimeout` alone satisfies both. The two are independent:
`startToCloseTimeout` caps one attempt and says nothing about the sequence,
and `RetryPolicy.maximumAttempts` defaults to `Infinity`, so an activity with
only a per-attempt bound retries a non-transient failure roughly every 100
seconds — forever.

**The merge, and why it's checked on the result, not each layer.** Options
come from three layers, shallow-merged in this order (later wins):

1. `declareWorkflow`'s own `activityOptions` (the workflow-wide default)
2. the activity's contract-level `defineActivity({ activityOptions })`
3. `activityOptionsByName` (the per-workflow, per-activity override)

The merge is **shallow** — a later layer's `retry` block replaces an earlier
layer's **entirely**, not field-by-field, matching Temporal's own
single-options-per-`proxyActivities`-call semantics. So a workflow-wide
`retry: { maximumAttempts: 3 }` and a contract-level
`retry: { initialInterval: "2s" }` each look bounded in isolation, but if the
contract-level one wins the merge, the resulting options have no
`maximumAttempts` at all — the total bound silently disappears. The guard
therefore checks the **merged** result for every reachable activity, not each
source independently; a per-source check cannot see this class of defect.

**`maximumAttempts` edge cases.** The rule is stated positively: a value counts
as a bound only when it is a finite positive integer.

- `Infinity` is **not** a bound — Temporal deletes the field when it is set to
  `Infinity` precisely because that value already _is_ the default, so
  writing it down changes nothing.
- `0`, negative values, and non-integers are **not** bounds either — but this
  guard doesn't reject them itself; it treats them as "no bound stated" and
  lets Temporal's own validation (`compileRetryPolicy`) surface its
  `ValueError` for the genuinely invalid value.

**What a violation looks like.** Every violation across every reachable
activity is collected and reported in a single `ContractMisuseError`, naming
each offending activity and which rule(s) it broke:

```
declareWorkflow: every reachable activity needs a total bound, so a failing activity
cannot retry forever. These do not:
  - chargePayment: missing a total bound (set `scheduleToCloseTimeout`, or a finite positive `retry.maximumAttempts`)
Options are merged from `declareWorkflow`'s `activityOptions`, the contract's
`defineActivity({ activityOptions })`, and `activityOptionsByName`. That merge is
shallow, so a later layer's `retry` replaces an earlier layer's entirely — check the
merged result, not each layer.
```

(The introductory phrase names only the bound(s) actually missing across all
offenders — a `chargePayment`-only violation like this one says "needs a
total bound"; a mix of per-attempt and total violations says "needs a
per-attempt bound and a total bound".)

**What this guard actually buys you, and what it does not.** Read this
carefully — it corrects an easy, plausible-sounding misconception.

`declareWorkflow` runs at module top level, so this check runs — and any
violation throws — while the **workflow bundle** is being evaluated, before
the Temporal SDK ever invokes the workflow function. A throw at that point is
caught by the worker's outer activation handler, which produces a Workflow
**Task** failure unconditionally. `ContractMisuseError` is a non-retryable
`ApplicationFailure`, but `nonRetryable` only has meaning on a
`FailWorkflowExecution` command — and this code path never emits one. So at
runtime, a violation does **not** fail the workflow cleanly, and it does not
fail fast. It **stalls** the workflow: Temporal retries the workflow task
indefinitely.

For a missing **per-attempt** bound, that is exactly what happened before
this guard existed too: `proxyActivities` itself throws a plain `TypeError`
at proxy construction when both `startToCloseTimeout` and
`scheduleToCloseTimeout` are absent, and that `TypeError` produces the
identical stall — this guard exists to give that failure a name and a list of
offenders before it happens, not to change what happens next. For a missing
**total** bound alone, there was no prior `TypeError` at all —
`proxyActivities` never checked `retry.maximumAttempts` — so the pre-guard
behavior was a workflow that starts and runs normally while one activity
retries a non-transient failure forever, roughly every 100 seconds, inside an
execution that looks healthy. The guard turns that silent, open-ended retry
loop into the same loud (if stalling) declaration-time signal as the
per-attempt case.

This is deliberate, not a shortcoming to be fixed later. Temporal retries
workflow tasks precisely so a bug can be fixed and redeployed with in-flight
executions resuming; making a misconfiguration terminal would permanently
fail every in-flight workflow on a bad deploy — including one mid-payment —
destroying exactly the work that stalling preserves.

The guard's real value is **at declaration time, in development and CI**: it
turns a missing bound into an immediate, readable error the first time the
workflow module loads — in a unit test, in a bundling step, in a worker
starting up — rather than a silently-`Running` execution discovered only in
production. It is not a production runtime safety net, and nothing in this
codebase should be read as claiming otherwise.

### `WorkflowContext`

The first argument to `implementation`.

#### `activities`

`Readonly<...>` map of every activity reachable from this workflow —
workflow-scoped plus global — flattened to one namespace.

Each returns an `AsyncResult<Output, ActivityErrorsFor<TActivity>>` — never a
plain value, and never a call that throws through. That is uniform across
every activity, declared `errors` map or not: `ActivityErrorsFor<TActivity>`
is `ActivityError | ActivityCancelledError`, plus the activity's declared
`ContractErrorUnion` when it has one. Input is validated before the call,
output after. See [The result model](/explanation/the-result-model) and
`propagateFailure` below.

The map's type is `WorkflowInferWorkflowContextActivities<TContract,
TWorkflowName>` and a single entry's is `WorkflowInferActivity<TActivity>` —
both exported for annotating helpers that take `context.activities`.
`ActivityErrorsFor<TActivity>` — the error union in that `AsyncResult` — is
exported too, for helpers generic over an activity's error type.

#### `info`

Temporal's `WorkflowInfo`: `workflowId`, `runId`, `attempt`,
`continueAsNewSuggested`, and the rest.

#### `errors`

Typed constructors for the workflow's declared `errors`. Throw one to fail the
execution with a typed, schema-validated failure:

```typescript
throw context.errors.EmptyOrder({ orderId: args.orderId });
```

An error with a `data` schema takes the payload first, then options; a data-less
error takes only options (`{ message?, cause? }`).

Empty object when the workflow declares no errors.

#### `handleSignal(name, handler)`

```typescript
(signalName: K, handler: SignalHandlerImplementation<...>) => void;
// handler: (args: Input) => void | Promise<void>
```

An incoming signal whose payload fails the schema is **dropped and logged**
(`log.warn` with the signal name and issues) — it never fails the execution.
A signal is fire-and-forget; any stale client can send one.

#### `handleQuery(name, handler)`

```typescript
(queryName: K, handler: QueryHandlerImplementation<...>) => void;
// handler: (args: Input) => Output
```

Must be synchronous. Both query schemas (input and output) must validate
synchronously — an async-validating schema (e.g. a zod async refinement)
trips a `ContractMisuseError` at bind time, not at first request.

#### `handleUpdate(name, handler)`

```typescript
(updateName: K, handler: UpdateHandlerImplementation<...>) => void;
// handler: (args: Input) => Promise<Output>
```

The update's **input** schema must validate synchronously (it feeds Temporal's
synchronous validator slot); the output schema may be async. An async input
schema trips a `ContractMisuseError` at bind time.

Names are constrained to what the contract declares. Register handlers inside
the implementation so they can close over workflow state. For an input-less
definition (`defineSignal()`, `defineQuery({ output })`,
`defineUpdate({ output })`) the handler receives `undefined`.

Binding a name the contract does not declare — possible only from untyped
code — throws `ContractMisuseError`, failing the execution terminally instead
of hanging it in Workflow Task retries.

`SignalHandlerImplementation`, `QueryHandlerImplementation`, and
`UpdateHandlerImplementation` are exported, so a handler can be declared
standalone and assigned in.

::: info Renamed in 8.0
These were `context.defineSignal` / `defineQuery` / `defineUpdate` before 8.0.
The `handle*` verb keeps the in-workflow binding tier distinct from the
`define*` contract-authoring tier. See the [upgrade guide](/how-to/upgrade-to-v8).
:::

#### `startChildWorkflow(contract, workflowName, options)`

```typescript
=> AsyncResult<
     TypedChildWorkflowHandle<TWorkflow>,
     ChildWorkflowError | ChildWorkflowCancelledError | ChildWorkflowNotFoundError
   >
```

`TypedChildWorkflowHandle` exposes:

| Member                | Type                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `workflowId`          | `string`                                                                                             |
| `firstExecutionRunId` | `string` — anchor of the child's execution chain, stable across continue-as-new                      |
| `signals`             | `Record<SignalName, (args) => AsyncResult<void, ChildWorkflowError \| ChildWorkflowCancelledError>>` |
| `result()`            | `AsyncResult<Output, ChildWorkflowError \| ChildWorkflowCancelledError>`                             |

The `signals` map (type `TypedChildWorkflowSignals`, exported) mirrors the
client handle's: one sender per signal declared on the child's contract entry.
The payload is validated before sending — an invalid payload fails early as
`Err(ChildWorkflowError)` — and the child parses it on receive.

`ChildWorkflowError`, `ChildWorkflowCancelledError`, and
`ChildWorkflowNotFoundError` each carry the child's `workflowName` as a
structured field. `TypedChildWorkflowHandle` and `TypedChildWorkflowOptions`
are exported for annotating stored handles.

#### Required `parentClosePolicy`

`TypedChildWorkflowOptions` — the `options` argument shared by both
`startChildWorkflow` and `executeChildWorkflow` — is Temporal's
`ChildWorkflowOptions` without `taskQueue` and `args`, plus a typed `args`,
and with `parentClosePolicy` **required** rather than optional. Temporal's
own field accepts `undefined` (via the deprecated
`PARENT_CLOSE_POLICY_UNSPECIFIED` union member), so this type `Exclude`s
`undefined` explicitly; without that, a "required" field that still accepts
`undefined` would require nothing. `"TERMINATE"` remains available and
reproduces Temporal's own default (kill the child when the parent closes) —
it simply has to be written down at the call site rather than inherited
silently. Choose `"REQUEST_CANCEL"` if the child needs to compensate before
exiting, or `"ABANDON"` for fire-and-forget work that should outlive its
parent.

#### `executeChildWorkflow(contract, workflowName, options)`

Starts and waits.

```typescript
=> AsyncResult<
     Output,
     ChildWorkflowError | ChildWorkflowCancelledError | ChildWorkflowNotFoundError
   >
```

#### `cancellableScope(fn)` / `nonCancellableScope(fn)`

```typescript
<T>(fn: () => T | Promise<T>) => AsyncResult<T, WorkflowCancelledError>;
```

`cancellableScope` surfaces cancellation as `Err(WorkflowCancelledError)`.
`nonCancellableScope` ignores outside cancellation for its duration — the way
to run cleanup that must not be interrupted.

In both, a **non-cancellation** throw is an unmodeled failure and rides the
defect channel, so the modeled error channel stays exactly one type.

#### `saga(options?)`

```typescript
(options?: { compensateOnCancellation?: boolean }) => WorkflowSagaBuilder<undefined, never>;
```

A sequence of steps whose compensations are unwound **LIFO** when a later step
fails. `step(run, undo?)` takes thunks — `run` receives nothing, `undo` receives
the value its own step produced — and both may answer a plain `Result` as well
as an `AsyncResult`, so an undo is written as the ordinary activity call it is.

```typescript
const fulfilled = await context
  .saga()
  .step(
    () => context.activities.reserveStock(order),
    (reservation) => context.activities.releaseStock({ id: reservation.id }),
  )
  .step(
    () => context.activities.chargeCard(order),
    (charge) => context.activities.refund({ id: charge.id }),
  )
  .step(() => context.activities.ship(order))
  .run();
```

**Which failures compensate is the decision this makes for you.** The undos run
on a **declared contract error** — a permanent domain answer, where what the
step did before saying no is knowable. They do **not** run on an
`ActivityError`, a `ChildWorkflowError` or a defect: a step that failed
unmodelled left state nobody can see, and un-deciding what you cannot see is a
second bug. That failure propagates untouched, so
[`propagateFailure`](#propagatefailure-result) still re-raises
Temporal's original failure.

Cancellation is the one case a caller may opt back in to, with
`saga({ compensateOnCancellation: true })` — for steps holding something a
cancellation has to release anyway: a seat, a reservation, a lock. Every undo
runs inside a **non-cancellable scope**, so a cancellation cannot interrupt the
walk-back it triggered — and, more to the point, a cancelled scope schedules no
activity at all, so the opt-in would otherwise be unable to compensate for the
very failure it exists for.

`run()` answers the last step's value, and the failure comes back **unchanged**,
so a caller triages exactly what it would have without the saga. A compensation
that itself **fails** becomes a defect carrying its own failure, which outranks
the failure that triggered the unwind — a refund that never happened is worse
news than the order that could not ship — and the remaining undos still run
first.

It is pure control flow — no timers, no clock, no randomness — so it replays
deterministically inside the sandbox. `workflowSaga` is the same function,
exported from `@temporal-contract/worker/workflow` for a workflow that composes
its steps in a helper.

#### `continueAsNew(...)`

```typescript
// same workflow
(args: Input, options?: TypedContinueAsNewOptions): Promise<never>;

// cross-contract
(contract, workflowName, args, options?): Promise<never>;
```

Args are validated against the destination workflow's input schema before
Temporal is called; on failure it throws `WorkflowInputValidationError`.
`TypedContinueAsNewOptions` (exported) is Temporal's `ContinueAsNewOptions`
without `workflowType` and `taskQueue` — the validated target wins, so a
`workflowType`/`taskQueue` slipped through untyped code is ignored. There is
no `retry` option.

Never returns normally.

### Errors exported here

`ActivityError`, `ActivityCancelledError`, `ActivityInputValidationError`,
`ActivityOutputValidationError`, `ChildWorkflowError`,
`ChildWorkflowCancelledError`, `ChildWorkflowNotFoundError`,
`ContractErrorDataValidationError`, `ContractMisuseError`,
`QueryInputValidationError`, `QueryOutputValidationError`,
`UpdateInputValidationError`, `UpdateOutputValidationError`, `ValidationError`,
`WorkflowCancelledError`, `WorkflowInputValidationError`,
`WorkflowOutputValidationError`

There is no `SignalInputValidationError` — an invalid signal payload is
dropped and logged, never thrown (see `handleSignal` above).

Each `ValidationError` subclass carries a readonly `direction: "input" |
"output"` field (the class names are unchanged; they remain
`ApplicationFailure` subclasses discriminated by `failure.type`).

#### `propagateFailure(result)`

```typescript
function propagateFailure<T, E>(result: AsyncResult<T, E>): Promise<T>;
```

Await an activity call and return its value, re-raising the original Temporal
failure so **Temporal** decides the workflow's outcome — the explicit
equivalent of the pre-8.0 "just let it throw" call site:

```typescript
import { propagateFailure } from "@temporal-contract/worker/workflow";

const { transactionId } = await propagateFailure(
  context.activities.chargeCard({ customerId, amount }),
);
```

**Do not use unthrown's `.getOrThrow()` for this.** It throws the
`ActivityError`/`ActivityCancelledError` wrapper — a `TaggedError`, not a
`TemporalFailure` — which Temporal treats as a workflow-_task_ failure and
retries indefinitely, stalling the workflow until its execution timeout
instead of failing it. `propagateFailure` re-raises the preserved
original failure instead — see [The result
model](/explanation/the-result-model).

`E` is intentionally unconstrained, so this also accepts the `AsyncResult`
returned by `context.executeChildWorkflow` / `context.startChildWorkflow`
(`ChildWorkflowError`, `ChildWorkflowCancelledError`) and by
`context.cancellableScope` / `context.nonCancellableScope`
(`WorkflowCancelledError`) — each re-raises its preserved `cause` the same
way. `ChildWorkflowNotFoundError` (no Temporal call ever happened — the
target contract doesn't declare the child workflow name) is converted to a
`ContractMisuseError` instead, since there is no prior Temporal failure to
re-raise.

#### `rethrowCancellation(error): never`

Re-raise a cancellation that surfaced on the modeled `Err(...)` channel.
`WorkflowCancelledError` (from `cancellableScope`), `ChildWorkflowCancelledError`,
and `ActivityCancelledError` are values — generic error handling that maps every
`Err` to a fallback would **complete** the workflow as `Completed` instead of
letting it end `Cancelled`. Its parameter type accepts only a cancellation
error — narrow to one first — and it never returns normally:

```typescript
import { ActivityCancelledError, rethrowCancellation } from "@temporal-contract/worker/workflow";

if (result.isErr()) {
  if (result.error instanceof ActivityCancelledError) {
    rethrowCancellation(result.error); // never returns — re-raises the cancellation
  }
  return { status: "failed" };
}
```

#### Worker error-tag constants

Literal-typed `_tag` constants mirroring the contract package, for
`P.tag(...)` without hand-writing the namespaced strings:
`ACTIVITY_ERROR_TAG`, `ACTIVITY_CANCELLED_ERROR_TAG`,
`ACTIVITY_DEFINITION_NOT_FOUND_ERROR_TAG`, `CHILD_WORKFLOW_ERROR_TAG`,
`CHILD_WORKFLOW_CANCELLED_ERROR_TAG`, `CHILD_WORKFLOW_NOT_FOUND_ERROR_TAG`,
`WORKFLOW_CANCELLED_ERROR_TAG`. (The `ValidationError` subclasses are
`ApplicationFailure`s discriminated by `failure.type`, so they have no tag
constant.)

Plus `ContractError`, `AnyContractError`, `ContractErrorConstructors`,
`ContractErrorOptions`, `ContractErrorUnion`.

## `@temporal-contract/worker/activity`

### `declareActivitiesHandler(options)`

```typescript
function declareActivitiesHandler<TContract, TContext>(
  options: DeclareActivitiesHandlerOptions<TContract, TContext>,
): ActivitiesHandler<TContract>;
```

| Option          | Type                      | Required |
| --------------- | ------------------------- | -------- |
| `contract`      | `ContractDefinition`      | yes      |
| `activities`    | nested implementation map | yes      |
| `createContext` | `() => TContext`          | no       |
| `middleware`    | `ActivityMiddleware`      | no       |

**The input map is nested; the returned handler is flat.** Global activities sit
at the root of the map you write; workflow-scoped ones nest under their
workflow's name, mirroring the contract. A workflow that declares no
activities needs no entry at all. The returned object is flat because
Temporal resolves one namespace at runtime.

The options bag is typed as `DeclareActivitiesHandlerOptions<TContract,
TContext, TInjected>` (exported).

TypeScript requires every activity in the contract to be implemented, and the
declaration **fails fast** at runtime too: a declared activity with no
implementation throws at declaration time (listing the missing names), and a
stray key — an implementation the contract never declared — throws
`ActivityDefinitionNotFoundError`.

**Shared activity across scopes.** One `defineActivity` object may be
referenced from several workflow scopes. Because Temporal has a single flat
activity namespace, every scope must supply the **same function reference**
(the duplicate is deduped, first registration wins) or the activity must be
hoisted to the contract's global `activities` map. Supplying two _different_
implementations for the same flat name throws at declaration time, naming the
activity and both scopes.

#### Standalone implementation types

To type an activity implementation outside the `declareActivitiesHandler` call
(so it can live in its own module with precise `args`/`helpers` inference) and
assign it into the nested map later:

- `GlobalActivityImplementationFor<TContract, TActivityName>` — a global
  activity.
- `ActivityImplementationFor<TContract, TWorkflowName, TActivityName>` — a
  workflow-local activity.

Both take an optional trailing `TContext` type parameter mirroring the
handler's injected context.

```typescript
const validateOrder: ActivityImplementationFor<
  typeof myContract,
  "orderWorkflow",
  "validateOrder"
> = ({ errors, input: args }) =>
  args.orderId ? OkAsync({ valid: true }) : ErrAsync(errors.EmptyOrder({}));
```

### Activity implementation signature

```typescript
(
  helpers: {
    errors: ContractErrorConstructors;
    context: TContext;
    args: WorkerInferInput<TActivity>;
  },
  args: WorkerInferInput<TActivity>,
) => AsyncResult<WorkerInferOutput<TActivity>, ApplicationFailure | ContractError>;
```

**Helpers first, input second** — oRPC's shape, which this family converged on:
its `ProcedureHandlerOptions` carries `input` and the handler still takes it
positionally, so `args` is on the record AND in the second parameter. Both
spellings are the same call:

```typescript
place: ({ errors, input }) => …  // the spelling to reach for
place: ({ errors }, args) => …   // or the positional shortcut, oRPC has both
place: ({ input }) => …          // consumes neither errors nor context
```

`args` is **parsed on receive** — the calling side validated the payload but
transmitted the original value, so a transforming schema applies exactly once.

What the wrapper does with your result:

| You return                | Temporal sees                                                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ok(value)`               | your original `value`, validated against the output schema (the consuming side parses it on receive)                                          |
| `Err(ApplicationFailure)` | the failure thrown; retry policy applies                                                                                                      |
| `Err(contractError)`      | `data` validated, thrown as `ApplicationFailure` with `type` = error name, `details[0]` = the original data, `nonRetryable` from the contract |
| a defect                  | the original cause re-thrown                                                                                                                  |

The wrapper does not hide `@temporalio/activity` — `Context.current()`,
`activityInfo()`, and heartbeats are all still available inside the body.

### `qualifyFailure(type, options)`

```typescript
function qualifyFailure(
  type: string,
  options: {
    // REQUIRED — which rejection causes are anticipated
    expected: ErrorClass | readonly ErrorClass[] | ((cause: unknown) => boolean) | "any";
    message?: string;
    nonRetryable?: boolean;
    details?: unknown[];
  },
): (cause: unknown, defect) => ApplicationFailure | TDefect;
```

Builds a **triaging** qualifier for `fromPromise`. `expected` is **required** —
it is the per-cause decision _is this failure part of the activity's model, or
a bug?_ A cause matching `expected` (an error class, an array of classes, a
predicate, or the literal `"any"`) is wrapped into the modeled
`ApplicationFailure` of the given `type`; **everything else rides the defect
channel** and re-throws at the activity edge with its original cause — so a
`TypeError` from a typo can no longer masquerade as your declared failure and
inherit its retry semantics.

```typescript
import { qualifyFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

fromPromise(
  gateway.charge(customerId, amount),
  qualifyFailure("CHARGE_FAILED", { expected: GatewayError }),
);

// several anticipated classes; a predicate works too
qualifyFailure("CARD_DECLINED", {
  expected: [CardDeclinedError, GatewayTimeoutError],
  nonRetryable: true,
});
```

Prefer a class or predicate for `expected`; `"any"` is a deliberate, greppable
escape hatch that restores the pre-8.0 blanket-wrap behavior.

For a matched `Error` cause the wrapper keeps its message and preserves it as
`cause`; a matched non-`Error` cause falls back to `options.message`, then
`String(cause)`.

::: info nonRetryable precedence
Explicit `options.nonRetryable` wins unconditionally. Omitted, a matched cause
that is itself an `ApplicationFailure` with `nonRetryable: true` propagates its
non-retryability to the wrapper — a permanent inner failure no longer silently
becomes retryable just because it was re-typed. Set `nonRetryable: false`
explicitly to force the wrapper retryable.
:::

### `ApplicationFailure`

Re-exported from `@temporalio/common` so you do not need a separate import.

### Middleware

#### `ActivityMiddleware<TContextIn, TContextOut>`

```typescript
(
  invocation: {
    activityName: string;
    workflowName: string | undefined;
    input: unknown; // already validated
    context: TContextIn;
  },
  next: ActivityMiddlewareNext<TContextOut>,
) => AsyncResult<unknown, ApplicationFailure | AnyContractError>;
```

Runs **inside** the validation boundary.

#### `ActivityMiddlewareNext`

```typescript
(opts?: { input?: unknown; context?: TContextOut }) =>
  AsyncResult<unknown, ApplicationFailure | AnyContractError>;
```

- `next()` — forward unchanged
- `next({ context })` — shallow-merge a context patch for everything downstream
- `next({ input })` — substitute the input. **Re-validated** against the input
  schema; an invalid substitution fails with `ActivityInputValidationError`

Calling `next` more than once re-runs the rest of the chain (retry). Returning
without calling it short-circuits.

#### `declareActivityMiddleware(middleware)`

Identity helper that pins the context type parameters without a variable
annotation.

#### `composeActivityMiddleware(...middlewares)`

Composes outermost-first, threading context types through — each middleware's
`TContextOut` bounds the next one's `TContextIn`. Overloads cover up to eight;
nest for longer chains.

#### `ActivityInvocationInfo`, `EmptyContext`, `AnyActivityMiddleware`

`EmptyContext` is `Record<never, never>` — a real "no properties" type rather
than the anything-goes `{}`.

### Errors exported here

`ActivityDefinitionNotFoundError`, `ActivityInputValidationError`,
`ActivityOutputValidationError`, `ContractErrorDataValidationError`,
`ValidationError`, plus the `ContractError` surface. The `/activity` entry also
re-exports the worker error-tag constants (`ACTIVITY_ERROR_TAG`,
`ACTIVITY_CANCELLED_ERROR_TAG`, and the rest — see the workflow entry's
[error-tag constants](#worker-error-tag-constants)).

## `@temporal-contract/worker/worker`

### `TypedWorker.create(options)`

```typescript
class TypedWorker {
  static create<TContract>(
    options: CreateWorkerOptions<TContract>,
  ): AsyncResult<TypedWorker, never>;

  readonly raw: Worker;
  run(): AsyncResult<void, never>;
  shutdown(): void;
}
```

The worker-side sibling of `TypedClient.create` — the org's `Typed*.create()`
factory shape. `CreateWorkerOptions<TContract>` (exported) is Temporal's
`WorkerOptions` without `taskQueue` (taken from the contract), plus `contract`,
an optional `activities`, and `verifyWorkflowRegistration`.

**`activities` is optional.** Omit it for a workflow-only worker — one that
polls exclusively for Workflow Tasks, leaving activities to a separate worker
process on the same task queue. See
[Configure a worker](/how-to/configure-a-worker#run-a-workflow-only-worker).

**`verifyWorkflowRegistration` (defaults to `true`).** A best-effort startup
check that the `workflowsPath` module registers every contract workflow under
its declared name. `TypedWorker.create` imports the module in the main thread,
identifies `declareWorkflow`-produced exports via their brand marker, and fails
creation (a `TechnicalError`-caused defect) when a contract workflow has
neither a `declareWorkflow`-produced export nor a plain function export under
its name, or when a declared workflow is exported under a name that differs
from its `workflowName` (Temporal registers workflows by _export_ name, so the
mismatch would register the wrong workflow type). The check only runs when
`workflowsPath` is a string (prebuilt `workflowBundle`s are skipped) and a
module that cannot be imported in the main thread is skipped silently — the
`Worker.create` bundling step is the authority on load failures. Set to `false`
to opt out.

**No modeled error.** Bundling failures, bad connections, and invalid options are
technical faults on the **defect** channel with a `TechnicalError` cause.
Inspect with `isDefect()` / `match({ defect })` / `recoverDefect`, or use
`.get()` to rethrow the original cause.

**Lifecycle.** `run()` starts the worker loop and resolves `Ok` after a clean
shutdown; a worker that fails while running surfaces as a defect (a
`TechnicalError` cause), and the underlying promise never rejects. `shutdown()`
initiates a graceful drain. Everything else Temporal offers — `runUntil`,
`getState`, tuning introspection — lives on the `raw` escape hatch.

### `workflowsPathFromURL(baseURL, relativePath)`

```typescript
function workflowsPathFromURL(baseURL: string, relativePath: string): string;
```

ESM-safe path resolution — the equivalent of `require.resolve` for
`workflowsPath`. Include the extension, and write `.js` even for TypeScript
sources.

```typescript
workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js");
```

### `TechnicalError`

Re-exported for `instanceof` checks on a defect's cause.

## Next

- [Client surface](/reference/client-surface)
- [Errors reference](/reference/errors)
- [Implement activities](/how-to/implement-activities)
