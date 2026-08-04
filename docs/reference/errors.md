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
serialization, and expose `issues` for in-process inspection.

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

Surfaces on the workflow side when calling an errors-declaring activity, and on
the client side when awaiting a workflow that declares errors.

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

### `WorkflowNotInContractError`

`_tag: "@temporal-contract/WorkflowNotInContractError"` · channel: `err`

The workflow name is not on the **contract**. A programming error, not a runtime
condition.

| Property             | Type       |
| -------------------- | ---------- |
| `workflowName`       | `string`   |
| `availableWorkflows` | `string[]` |

From `startWorkflow`, `executeWorkflow`, `signalWithStart`, `getHandle`,
`schedule.create`.

### `WorkflowExecutionNotFoundError`

`_tag: "@temporal-contract/WorkflowExecutionNotFoundError"` · channel: `err`

The targeted **execution** does not exist in the namespace. Distinct from
`WorkflowNotInContractError` above.

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

| Property     | Type                                           |
| ------------ | ---------------------------------------------- |
| `workflowId` | `string`                                       |
| `cause`      | `TemporalFailure \| undefined` — **unwrapped** |

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

From `executeWorkflow` and `handle.result()`.

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

| Class                              | Thrown when                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `WorkflowInputValidationError`     | Workflow input fails its schema                                                       |
| `WorkflowOutputValidationError`    | Workflow return value fails its schema                                                |
| `ActivityInputValidationError`     | Activity input fails its schema, or a middleware substitution does                    |
| `ActivityOutputValidationError`    | Activity return value fails its schema                                                |
| `QueryInputValidationError`        | Query payload fails its schema                                                        |
| `QueryOutputValidationError`       | Query return value fails its schema                                                   |
| `UpdateInputValidationError`       | Update payload fails its schema                                                       |
| `UpdateOutputValidationError`      | Update return value fails its schema                                                  |
| `ContractErrorDataValidationError` | A contract error's `data` fails its schema, **or** an undeclared error name is raised |
| `ContractMisuseError`              | Workflow-sandbox code misuses the contract — see below                                |

`ValidationError` itself is exported as the abstract base, for `instanceof`
checks across all of them.

There is **no** `SignalInputValidationError`: a signal payload failing its
schema is dropped and logged (`log.warn`), never thrown — a fire-and-forget
message must not be able to kill the execution.

### `ContractMisuseError`

Extends `ValidationError` (non-retryable `ApplicationFailure`), with an empty
`issues` array — the misuse is structural, not a payload failure. Thrown when
workflow-sandbox code misuses the contract surface: binding a
signal/query/update handler for an undeclared name, using an async-validating
schema where Temporal requires synchronous validation, or reaching an activity
no options cover. Failing terminally is the point — a plain `Error` thrown
from sandbox code would be retried as a Workflow Task failure forever, leaving
the execution silently `Running`.

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

| Property       | Type                                 |
| -------------- | ------------------------------------ |
| `activityName` | `string`                             |
| `cause`        | the **unwrapped** actionable failure |

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

A child workflow operation failed. `cause` is the **unwrapped** underlying
failure, lifted out of Temporal's `ChildWorkflowFailure` wrapper.

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

| Operation                                       | `err` channel                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `TypedClient.create`                            | `never`                                                                                                         |
| `startWorkflow`                                 | `WorkflowNotInContractError \| WorkflowValidationError \| WorkflowAlreadyStartedError`                          |
| `executeWorkflow`                               | the above, plus `WorkflowFailedError \| WorkflowExecutionNotFoundError \| ContractErrorUnion`                   |
| `signalWithStart`                               | `WorkflowNotInContractError \| WorkflowValidationError \| SignalValidationError \| WorkflowAlreadyStartedError` |
| `getHandle` (sync `Result`)                     | `WorkflowNotInContractError`                                                                                    |
| `handle.queries.*`                              | `QueryValidationError \| WorkflowExecutionNotFoundError`                                                        |
| `handle.signals.*`                              | `SignalValidationError \| WorkflowExecutionNotFoundError`                                                       |
| `handle.updates.*`                              | `UpdateValidationError \| WorkflowExecutionNotFoundError`                                                       |
| `handle.startUpdate` / update-handle `result()` | `UpdateValidationError \| WorkflowExecutionNotFoundError`                                                       |
| `handle.result()`                               | `ContractErrorUnion \| WorkflowValidationError \| WorkflowFailedError \| WorkflowExecutionNotFoundError`        |
| `handle.terminate/cancel/describe/fetchHistory` | `WorkflowExecutionNotFoundError`                                                                                |
| `schedule.create`                               | `WorkflowNotInContractError \| WorkflowValidationError \| ScheduleAlreadyExistsError`                           |
| `schedule` handle methods                       | `ScheduleNotFoundError`                                                                                         |

### Worker

| Operation                                  | `err` channel                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `TypedWorker.create` / `TypedWorker.run`   | `never`                                                                           |
| activity call, no declared errors          | `ActivityError \| ActivityCancelledError`                                         |
| activity call, declared errors             | `ContractErrorUnion \| ActivityError \| ActivityCancelledError`                   |
| `startChildWorkflow`                       | `ChildWorkflowError \| ChildWorkflowCancelledError \| ChildWorkflowNotFoundError` |
| `executeChildWorkflow`                     | same                                                                              |
| child `handle.result()`                    | `ChildWorkflowError \| ChildWorkflowCancelledError`                               |
| child `handle.signals.*`                   | `ChildWorkflowError \| ChildWorkflowCancelledError`                               |
| `cancellableScope` / `nonCancellableScope` | `WorkflowCancelledError`                                                          |

An empty `err` channel (`never`) means every failure is a defect.

## Next

- [The result model](/explanation/the-result-model)
- [Model domain errors](/how-to/model-domain-errors)
- [Troubleshoot](/how-to/troubleshoot)
