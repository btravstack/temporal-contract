# Errors

Every error class, the channel it rides, and where it comes from.

## The two shapes

temporal-contract errors come in two families.

**`TaggedError` classes** carry a `_tag` discriminant used by unthrown's
exhaustive matcher. Tags are namespaced with the package scope
(`"@temporal-contract/…"`) so they never collide with your own or another
library's. `.name` stays the bare class name for readable logs.

The snippets on this page are shape fragments, not runnable programs. `P` is
unthrown's pattern namespace throughout — `import { P } from "unthrown"`.

```typescript
matcher.with(P.tag("@temporal-contract/WorkflowFailedError"), (error) => ...);
```

**`ValidationError` subclasses** extend Temporal's `ApplicationFailure` instead.
This is deliberate: Temporal's terminal-failure semantics depend on it, so a
validation failure fails the task permanently rather than retrying forever. They
carry the concrete subclass name as the failure `type`, which is what survives
serialization, and expose `issues` for in-process inspection. Their `message`
lists only the failing paths (`at email; at items[0].qty`) because it is stored
in history unencrypted; the full issues — schema messages included — ride
`details[0]` as `{ message, path }` records, which payload codecs do encrypt.

```typescript
if (error instanceof WorkflowInputValidationError) {
  console.error(error.issues);
}
```

## The three channels

| Channel  | Contains                                             |
| -------- | ---------------------------------------------------- |
| `ok`     | Success                                              |
| `err`    | Anticipated domain failures — branch on these        |
| `defect` | Unanticipated failures — bugs, infrastructure faults |

Since 8.0, `TechnicalError` and `RuntimeClientError` ride the **defect** channel
and appear in no modeled error union. See
[The result model](/explanation/the-result-model).

## Contract errors

From `@temporal-contract/contract/errors`; re-exported by the worker and client.

### `ContractError`

`_tag: "@temporal-contract/ContractError"` · channel: `err`

A domain error declared on a contract's `errors` map. One class covers every
declared error; `errorName` is the discriminant.

| Property    | Type                                                            |
| ----------- | --------------------------------------------------------------- |
| `errorName` | the declared key, and the `ApplicationFailure.type` on the wire |
| `data`      | payload, validated against the declared schema                  |
| `message`   | overridable per instance                                        |
| `cause`     | optional                                                        |

```typescript
matcher.with(P.tag("@temporal-contract/ContractError"), (error) => {
  switch (error.errorName) {
    case "CardDeclined":
      return error.data.reason;
  }
});
```

Surfaces on the workflow side when calling an errors-declaring activity or
child workflow, and on the client side when awaiting a workflow that declares
errors.

Related types: `AnyContractError`, `ContractErrorUnion`,
`ContractErrorInputUnion`, `ContractErrorConstructors`, `ContractErrorOptions`.

### `TechnicalError`

`_tag: "@temporal-contract/TechnicalError"` · channel: **defect only**

An infrastructure fault — a connection failure, a workflow bundle that will not
compile. Never appears in a modeled `E` channel; it is only ever a defect's
`cause`.

| Property  | Type                   |
| --------- | ---------------------- |
| `message` | descriptive            |
| `cause`   | the underlying failure |

```typescript
const result = await TypedWorker.create({ ... });
if (result.isDefect() && result.cause instanceof TechnicalError) {
  console.error(result.cause.message, result.cause.cause);
}
```

## Client errors

From `@temporal-contract/client`.

### `RuntimeClientError`

`_tag: "@temporal-contract/RuntimeClientError"` · channel: **defect only**

A technical failure with no more specific class — an unrecognized Temporal
rejection, a transport error.

| Property    | Type                      |
| ----------- | ------------------------- |
| `operation` | the operation that failed |
| `cause`     | the underlying failure    |

A workflow, signal, or update name the contract does not declare has no error
class: the types only admit declared names, so one that slips past them (a
cast, an untyped call) is a **defect** carrying a `TechnicalError` with a direct
message.

### `WorkflowExecutionNotFoundError`

`_tag: "@temporal-contract/WorkflowExecutionNotFoundError"` · channel: `err`

The targeted **execution** does not exist in the namespace.

| Property     | Type                  |
| ------------ | --------------------- |
| `workflowId` | `string`              |
| `runId`      | `string \| undefined` |
| `cause`      | `unknown`             |

From every handle method, and from `executeWorkflow` when the execution goes
missing mid-flight.

### `WorkflowAlreadyStartedError`

`_tag: "@temporal-contract/WorkflowAlreadyStartedError"` · channel: `err`

Starting collided with an existing execution. Usually a workflow-id reuse policy
rejecting a duplicate while a previous run is still in retention.

| Property       | Type      |
| -------------- | --------- |
| `workflowType` | `string`  |
| `workflowId`   | `string`  |
| `cause`        | `unknown` |

Branch on this to make a start idempotent — fetch the existing handle and
continue.

### `ScheduleAlreadyExistsError`

`_tag: "@temporal-contract/ScheduleAlreadyExistsError"` · channel: `err`

`schedule.create` collided with an existing (running, not deleted) schedule
under the same id. Branch on it for create-if-absent semantics.

| Property     | Type      |
| ------------ | --------- |
| `scheduleId` | `string`  |
| `cause`      | `unknown` |

### `ScheduleNotFoundError`

`_tag: "@temporal-contract/ScheduleNotFoundError"` · channel: `err`

The schedule id is unknown to the Temporal server — wrong id, or the schedule
was deleted. From every `TypedScheduleHandle` method.

| Property     | Type      |
| ------------ | --------- |
| `scheduleId` | `string`  |
| `cause`      | `unknown` |

### `WorkflowFailedError`

`_tag: "@temporal-contract/WorkflowFailedError"` · channel: `err`

The workflow completed with a failure.

| Property     | Type                                                                                   |
| ------------ | -------------------------------------------------------------------------------------- |
| `workflowId` | `string`                                                                               |
| `cause`      | `TemporalFailure \| undefined` — **unwrapped**                                         |
| `retryState` | Temporal's `RetryState \| undefined` — why it stopped retrying (e.g. maximum attempts) |

`cause` is the underlying `TemporalFailure` lifted out of Temporal's wrapper, so
you can branch in one step:

```typescript
if (error.cause instanceof ApplicationFailure) {
  console.error(error.cause.type);
}
```

`TemporalFailure` is the union of `ApplicationFailure`, `CancelledFailure`,
`TerminatedFailure`, `TimeoutFailure`, `ChildWorkflowFailure`, `ServerFailure`,
`ActivityFailure`.

From `executeWorkflow` and `handle.result()` — also for a failure whose `type`
names a declared contract error but does not rehydrate into it (see
`onRehydrationMiss` on [`TypedClient.create`](/reference/client-surface#typedclient-create-options)).

### Query and update errors

All `TaggedError`s on the `err` channel.

| Class                              | When                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `QueryFailedError`                 | No handler registered for the query, or the handler threw (Temporal's `QueryRejectedError` included)                                        |
| `UpdateRejectedError`              | The worker-side validator rejected the update before admission                                                                              |
| `UpdateFailedError`                | The admitted update handler failed                                                                                                          |
| `UpdateRpcTimeoutOrCancelledError` | The update **call** timed out or was cancelled. Says nothing about the update itself — retry with the same `updateId`, or `getUpdateHandle` |

### Client-side validation errors

All `TaggedError`s on the `err` channel, all carrying `issues`.

| Class                     | Tag suffix                | Extra properties                                               |
| ------------------------- | ------------------------- | -------------------------------------------------------------- |
| `WorkflowValidationError` | `WorkflowValidationError` | `workflowName`, `direction: "input" \| "output"`, `workflowId` |
| `QueryValidationError`    | `QueryValidationError`    | `queryName`, `direction`                                       |
| `SignalValidationError`   | `SignalValidationError`   | `signalName`                                                   |
| `UpdateValidationError`   | `UpdateValidationError`   | `updateName`, `direction`                                      |

## Worker errors

From `@temporal-contract/worker/workflow` and `/activity`.

### `ValidationError` subclasses

These extend `ApplicationFailure`, are **non-retryable**, and carry `issues`.
They are thrown, not returned.

| Class                              | Thrown when                                                        |
| ---------------------------------- | ------------------------------------------------------------------ |
| `WorkflowInputValidationError`     | Workflow input fails its schema                                    |
| `WorkflowOutputValidationError`    | Workflow return value fails its schema                             |
| `ActivityInputValidationError`     | Activity input fails its schema, or a middleware substitution does |
| `ActivityOutputValidationError`    | Activity return value fails its schema                             |
| `QueryInputValidationError`        | Query payload fails its schema                                     |
| `QueryOutputValidationError`       | Query return value fails its schema                                |
| `UpdateInputValidationError`       | Update payload fails its schema                                    |
| `UpdateOutputValidationError`      | Update return value fails its schema                               |
| `ContractErrorDataValidationError` | A contract error's `data` fails its schema                         |
| `ContractMisuseError`              | Code misuses the contract structurally — see below                 |

`ValidationError` itself is exported as the abstract base, for `instanceof`
checks across all of them.

There is **no** `SignalInputValidationError`: a signal payload failing its
schema is dropped and logged (`log.warn`), never thrown — a fire-and-forget
message must not be able to kill the execution.

### `ContractMisuseError`

Extends `ValidationError` (non-retryable `ApplicationFailure`), with an empty
`issues` array — the misuse is structural, not a payload failure. Exported
from both `/workflow` and `/activity`. Thrown at three different points:

- **Inside the running workflow** — binding a signal/query/update handler for
  an undeclared name, a query/update schema that validates asynchronously
  where Temporal requires synchronous validation (caught per call, on the
  first payload that goes async), raising a `ContractError` whose name the
  workflow does not declare, or `continueAsNew` into a workflow the contract
  does not declare. Thrown after Temporal has invoked the workflow function,
  so it fails the execution terminally with a clear message — a plain `Error`
  at that point would be retried as a Workflow Task failure forever.
- **At `declareWorkflow`, at module top level** — reaching an activity no
  options cover, naming a workflow the contract does not declare, or an
  `activityOptionsByName` key that matches no declared activity. Inside the
  sandbox a throw there is a Workflow Task failure whatever its class, so it
  would stall every task; `TypedWorker.create`'s registration check
  (`verifyWorkflowRegistration`, on by default) imports the workflows module
  first and **fails worker startup** on it instead (a `TechnicalError`-caused
  defect). See [Worker surface → Activity
  bounds](/reference/worker-surface#activity-bounds).
- **At `declareActivitiesHandler`** — a missing, conflicting, or ambiguous
  activity implementation.

### `ActivityDefinitionNotFoundError`

`_tag: "@temporal-contract/ActivityDefinitionNotFoundError"`

An activity name has no definition on the contract.

| Property               | Type                |
| ---------------------- | ------------------- |
| `activityName`         | `string`            |
| `availableDefinitions` | `readonly string[]` |

### `ActivityError`

`_tag: "@temporal-contract/ActivityError"` · channel: `err`

Any activity call failed for a reason **other** than one of its declared
errors — retries exhausted, a timeout, an undeclared `ApplicationFailure`
type, or a boundary validation failure. This is every activity's fallback:
one with no `errors` map has no declared-error members to fall through, so
every non-cancellation failure lands here.

| Property          | Type                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activityName`    | `string`                                                                                                                                                        |
| `cause`           | the **unwrapped** actionable failure                                                                                                                            |
| `originalFailure` | the failure exactly as caught, **before** the unwrap (typically Temporal's `ActivityFailure` wrapper) — `undefined` when there is no separate wrapper to retain |

`originalFailure` exists so `propagateFailure` can re-raise the exact
failure Temporal originally produced without changing what `cause` means for
existing consumers that narrow on it — see [Worker
surface](/reference/worker-surface#propagatefailure-result).

### `ActivityCancelledError`

`_tag: "@temporal-contract/ActivityCancelledError"` · channel: `err`

A call to an activity was cancelled — declared `errors` map or not. A sibling
of `ActivityError`, not a subclass, so call sites discriminate on the tag.

::: warning Swallowing this changes the workflow outcome
Cancellation rides this modeled `Err(...)` channel, so generic handling that
folds every `Err` to a fallback value absorbs it — the workflow completes
`Completed` instead of `Cancelled`. Re-raise it with `rethrowCancellation`
when the workflow should honor the request. See [Handle
cancellation](/how-to/handle-cancellation).
:::

| Property       | Type      |
| -------------- | --------- |
| `activityName` | `string`  |
| `cause`        | `unknown` |

### `ChildWorkflowNotFoundError`

`_tag: "@temporal-contract/ChildWorkflowNotFoundError"` · channel: `err`

The workflow name is not on the contract passed to `startChildWorkflow` /
`executeChildWorkflow`.

| Property             | Type                |
| -------------------- | ------------------- |
| `workflowName`       | `string`            |
| `availableWorkflows` | `readonly string[]` |

### `ChildWorkflowError`

`_tag: "@temporal-contract/ChildWorkflowError"` · channel: `err`

A child workflow operation failed for a reason other than one of the child's
declared errors (those rehydrate into typed `ContractError`s). `cause` is the
**unwrapped** underlying failure, lifted out of Temporal's
`ChildWorkflowFailure` wrapper.

### `ChildWorkflowCancelledError`

`_tag: "@temporal-contract/ChildWorkflowCancelledError"` · channel: `err`

The child was cancelled — directly, via its parent, or via an enclosing scope.
A sibling of `ChildWorkflowError`, so an exhaustive matcher folds the union
cleanly.

| Property       | Type      |
| -------------- | --------- |
| `workflowName` | `string`  |
| `cause`        | `unknown` |

### `WorkflowCancelledError`

`_tag: "@temporal-contract/WorkflowCancelledError"` · channel: `err`

A typed cancellation scope was cancelled. Returned by `cancellableScope` (when
the workflow or an ancestor cancels) and by `nonCancellableScope` (only when
cancellation is raised from inside the scope).

A **non-cancellation** throw inside a scope is an unmodeled failure and rides
the defect channel instead.

## Error channel by operation

### Client

| Operation                                       | `err` channel                                                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TypedClient.create`                            | `never`                                                                                                                                                                               |
| `startWorkflow`                                 | `WorkflowValidationError \| WorkflowAlreadyStartedError`                                                                                                                              |
| `executeWorkflow`                               | the above, plus everything `handle.result()` can produce                                                                                                                              |
| `signalWithStart`                               | `WorkflowValidationError \| SignalValidationError \| WorkflowAlreadyStartedError`                                                                                                     |
| `workflowIdFor`                                 | `WorkflowValidationError`                                                                                                                                                             |
| `getHandle`                                     | none — returns the handle directly                                                                                                                                                    |
| `handle.queries.*`                              | `QueryValidationError \| QueryFailedError \| WorkflowExecutionNotFoundError`                                                                                                          |
| `handle.signals.*`                              | `SignalValidationError \| WorkflowExecutionNotFoundError`                                                                                                                             |
| `handle.updates.*` / update-handle `result()`   | `UpdateValidationError \| UpdateRejectedError \| UpdateFailedError \| UpdateRpcTimeoutOrCancelledError \| WorkflowExecutionNotFoundError`                                             |
| `handle.startUpdate`                            | `UpdateValidationError \| UpdateRpcTimeoutOrCancelledError \| WorkflowExecutionNotFoundError`                                                                                         |
| `executeUpdateWithStart`                        | `WorkflowValidationError \| UpdateValidationError \| WorkflowAlreadyStartedError \| UpdateRejectedError \| UpdateFailedError \| UpdateRpcTimeoutOrCancelledError`                     |
| `handle.result()`                               | `ContractErrorUnion \| WorkflowValidationError \| WorkflowFailedError \| WorkflowCancelledError \| WorkflowTerminatedError \| WorkflowTimeoutError \| WorkflowExecutionNotFoundError` |
| `handle.terminate/cancel/describe/fetchHistory` | `WorkflowExecutionNotFoundError`                                                                                                                                                      |
| `schedule.create`                               | `WorkflowValidationError \| ScheduleAlreadyExistsError`                                                                                                                               |
| `schedule` handle methods                       | `ScheduleNotFoundError`                                                                                                                                                               |

### Worker

| Operation                                  | `err` channel                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `TypedWorker.create` / `run` / `shutdown`  | `never`                                                                              |
| activity call, no declared errors          | `ActivityError \| ActivityCancelledError`                                            |
| activity call, declared errors             | `ContractErrorUnion \| ActivityError \| ActivityCancelledError`                      |
| `startChildWorkflow`                       | `ChildWorkflowError \| ChildWorkflowCancelledError \| ChildWorkflowNotFoundError`    |
| `executeChildWorkflow`                     | same, plus the child's declared errors (`ChildWorkflowContractErrorsOf`)             |
| child `handle.result()`                    | `ChildWorkflowError \| ChildWorkflowCancelledError` plus the child's declared errors |
| child `handle.signals.*`                   | `ChildWorkflowError \| ChildWorkflowCancelledError`                                  |
| `cancellableScope` / `nonCancellableScope` | `WorkflowCancelledError`                                                             |

An empty `err` channel (`never`) means every failure is a defect.

## Next

- [The result model](/explanation/the-result-model)
- [Model domain errors](/how-to/model-domain-errors)
- [Troubleshoot](/how-to/troubleshoot)
