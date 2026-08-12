# Client surface

Everything exported from `@temporal-contract/client`.

Generated per-symbol docs: [API reference](/api/client/).

The surface is split in two: `TypedClient` is **connection-scoped** — it owns
the underlying `Client` and the escape hatch — and hands out
**contract-scoped** `ContractClient`s via `for()`.

## `TypedClient`

### `TypedClient.create(options)`

```typescript
// options: CreateClientOptions
static create(options: {
  client: Client; // from @temporalio/client
}): AsyncResult<TypedClient, never>;
```

The options bag is the exported `CreateClientOptions`.

**No modeled error.** Setup faults — a `Client` older than 1.16 (no Schedule
API), a connection that cannot be established — ride the defect channel with a
`TechnicalError` cause. `.get()` rethrows the original cause:

```typescript
import { TypedClient } from "@temporal-contract/client";
import { Client, Connection } from "@temporalio/client";

const connection = await Connection.connect();
const client = await TypedClient.create({ client: new Client({ connection }) }).get();
```

Create it **once, at process start** — it awaits `ensureConnected()` eagerly
so a bad address or namespace fails here, not on the first operation.

### `for(contract)`

```typescript
for<TContract extends ContractDefinition>(contract: TContract): ContractClient<TContract>;
```

Binds a contract. **Synchronous and infallible** — valid in a field
initializer. Memoized per contract identity, so `for(c) === for(c)` and
calling it per request is free.

```typescript
const orders = client.for(orderContract);
const shipments = client.for(shipmentContract); // same connection, second contract
```

### `raw`

The underlying `@temporalio/client` `Client` — the escape hatch for anything
the typed surface does not cover yet (`raw.workflow.list(...)`,
`raw.workflow.count(...)`). Calls made through `raw` bypass contract
validation.

## `ContractClient<TContract>`

Obtained from `TypedClient.for` — **not constructible directly** (its
constructor is not public API). Written as an annotation:
`ContractClient<typeof orderContract>`.

Two readonly getters expose what it is bound to, for logging and metrics
labels:

| Getter      | Type                     |
| ----------- | ------------------------ |
| `contract`  | `TContract`              |
| `taskQueue` | `TContract["taskQueue"]` |

### `executeWorkflow(workflowName, options)`

Starts and waits.

```typescript
=> AsyncResult<
     Output,
     | ContractErrorUnion            // when the workflow declares errors
     | WorkflowNotInContractError
     | WorkflowValidationError
     | WorkflowAlreadyStartedError
     | WorkflowFailedError
     | WorkflowCancelledError        // the server closed the execution:
     | WorkflowTerminatedError       // first-class outcome errors, each
     | WorkflowTimeoutError          // keeping the TemporalFailure as `cause`
     | WorkflowExecutionNotFoundError
   >
```

A cancelled / terminated / timed-out execution surfaces as its own
first-class error rather than being buried in `WorkflowFailedError.cause` — no
`instanceof` digging. Cancellation is a modeled `Err`, so give it its own
matcher arm instead of folding it into a blanket "failed" branch.

### `startWorkflow(workflowName, options)`

Returns a handle as soon as the workflow starts.

```typescript
=> AsyncResult<
     TypedWorkflowHandle<TWorkflow>,
     | WorkflowNotInContractError
     | WorkflowValidationError
     | WorkflowAlreadyStartedError
   >
```

### `signalWithStart(workflowName, options)`

Starts the workflow if it does not exist, and delivers the signal either way.

```typescript
=> AsyncResult<
     TypedWorkflowHandleWithSignaledRunId<TWorkflow>,
     | WorkflowNotInContractError
     | WorkflowValidationError
     | SignalValidationError
     | WorkflowAlreadyStartedError
   >
```

The returned handle adds `signaledRunId` — the run that received the signal,
which is not necessarily a newly started one.

### `getHandle(workflowName, workflowId, options?)`

Binds to an existing execution. **Synchronous** — no I/O is involved, so it
returns a plain `Result`:

```typescript
=> Result<TypedWorkflowHandle<TWorkflow>, WorkflowNotInContractError>
```

`TypedGetHandleOptions` extends Temporal's `GetWorkflowHandleOptions`:

| Field                 | Effect                                                                    |
| --------------------- | ------------------------------------------------------------------------- |
| `runId`               | Bind to a specific execution instead of the latest                        |
| `firstExecutionRunId` | Chain interlock — mutating methods refuse to cross into another chain     |
| `followRuns`          | Whether `result()` follows continue-as-new / retries (Temporal's default) |

### `schedule`

A `TypedScheduleClient<TContract>`. See below.

## Option types

### `TypedWorkflowStartOptions`

Temporal's `WorkflowStartOptions` without `taskQueue`, `args`,
`searchAttributes`, and `typedSearchAttributes`, plus:

| Field              | Type                                            |
| ------------------ | ----------------------------------------------- |
| `args`             | `ClientInferInput<TWorkflow>`                   |
| `searchAttributes` | `TypedSearchAttributeMap<TWorkflow>` (optional) |

`workflowId`, `workflowExecutionTimeout`, `workflowRunTimeout`, `retry`, `memo`,
and the rest pass through. `args` is omittable when the workflow's input
schema accepts `undefined`.

### `TypedSignalWithStartOptions`

The above, plus:

| Field        | Type                          |
| ------------ | ----------------------------- |
| `signalName` | a signal name on the workflow |
| `signalArgs` | `ClientInferInput<TSignal>`   |

`signalArgs` is omittable when the signal's input schema accepts `undefined`
(a payload-less `defineSignal()`).

::: warning It is `signalName`, not `signal`
:::

### `TypedStartUpdateOptions`

For `handle.startUpdate`:

| Field          | Type                                                                        |
| -------------- | --------------------------------------------------------------------------- |
| `args`         | `ClientInferInput<TUpdate>` — omittable when the schema accepts `undefined` |
| `updateId`     | `string` (optional) — dedupe key                                            |
| `waitForStage` | `"ACCEPTED"` — the only supported stage, and the default                    |

## `TypedWorkflowHandle`

| Member                     | Type                                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowId`               | `string`                                                                                                                                                                                                   |
| `runId`                    | `string \| undefined` — the bound run, when known                                                                                                                                                          |
| `firstExecutionRunId`      | `string \| undefined` — first run of the chain, when known                                                                                                                                                 |
| `raw`                      | the underlying `@temporalio/client` `WorkflowHandle` — escape hatch; bypasses validation                                                                                                                   |
| `queries`                  | `Record<QueryName, (args) => AsyncResult<Output, QueryValidationError \| QueryFailedError \| WorkflowExecutionNotFoundError>>`                                                                             |
| `signals`                  | `Record<SignalName, (args) => AsyncResult<void, SignalValidationError \| WorkflowExecutionNotFoundError>>`                                                                                                 |
| `updates`                  | `Record<UpdateName, (args) => AsyncResult<Output, UpdateValidationError \| UpdateRejectedError \| UpdateFailedError \| WorkflowExecutionNotFoundError>>`                                                   |
| `startUpdate(name, opts?)` | `AsyncResult<TypedWorkflowUpdateHandle<TUpdate>, UpdateValidationError \| UpdateRejectedError \| UpdateFailedError \| WorkflowExecutionNotFoundError>`                                                     |
| `result()`                 | `AsyncResult<Output, ContractErrorUnion \| WorkflowValidationError \| WorkflowFailedError \| WorkflowCancelledError \| WorkflowTerminatedError \| WorkflowTimeoutError \| WorkflowExecutionNotFoundError>` |
| `terminate(reason?)`       | `AsyncResult<void, WorkflowExecutionNotFoundError>`                                                                                                                                                        |
| `cancel()`                 | `AsyncResult<void, WorkflowExecutionNotFoundError>`                                                                                                                                                        |
| `describe()`               | `AsyncResult<WorkflowExecutionDescription, WorkflowExecutionNotFoundError>`                                                                                                                                |
| `fetchHistory()`           | `AsyncResult<History, WorkflowExecutionNotFoundError>`                                                                                                                                                     |

`queries`, `signals`, and `updates` are generated from the contract — only the
declared operations exist, with their schemas' types. Payloads are validated
before dispatch and parsed by the worker on receive; the payload argument is
omittable for input-less definitions. Results (queries, updates, `result()`)
are parsed on receive against the contract's output schema.

The `updates` map executes and waits (Temporal's `executeUpdate`);
`startUpdate` starts without waiting and returns a handle. An update
distinguishes a worker-side admission rejection (`UpdateRejectedError`) from a
failed admitted handler (`UpdateFailedError`); a query with no registered
handler, or one whose handler threw, surfaces as `QueryFailedError`. All are
modeled `Err`s — before 8.0 they leaked as defects.

`result()` surfaces a declared contract error as a `ContractError` instead of a
generic `WorkflowFailedError`, and a cancelled / terminated / timed-out
execution as the first-class `WorkflowCancelledError` / `WorkflowTerminatedError`
/ `WorkflowTimeoutError` (each keeps the original `TemporalFailure` as `cause`).
The failure-to-`ContractError` rehydration reads the wire failure through the
`ApplicationFailureLike` shape (exported from
[`@temporal-contract/contract/errors`](/reference/contract-surface#tag-constants-and-the-wire-marker)).

### `TypedWorkflowUpdateHandle`

Returned by `startUpdate`:

| Member          | Type                                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| `updateId`      | `string`                                                                       |
| `workflowId`    | `string`                                                                       |
| `workflowRunId` | `string \| undefined`                                                          |
| `result()`      | `AsyncResult<Output, UpdateValidationError \| WorkflowExecutionNotFoundError>` |

## Search attributes

### `readTypedSearchAttributes(workflowDef, instance)`

```typescript
function readTypedSearchAttributes<TWorkflow>(
  workflowDef: TWorkflow,
  instance: TypedSearchAttributes,
): Partial<TypedSearchAttributeMap<TWorkflow>>;
```

Turns Temporal's untyped instance into a typed partial object. Every field is
optional — an attribute never set is `undefined`.

```typescript
const described = await handle.describe();
if (described.isOk()) {
  const attrs = readTypedSearchAttributes(
    orderContract.workflows.processOrder,
    described.value.typedSearchAttributes,
  );
  attrs.customerId; // string | undefined
}
```

### `TypedSearchAttributeMap<TWorkflow>`

Maps each declared attribute name to the TypeScript type its `kind` implies.

## `TypedScheduleClient`

Reached as `contractClient.schedule`. Not constructible directly.

### `create(workflowName, options)`

```typescript
=> AsyncResult<
     TypedScheduleHandle,
     WorkflowNotInContractError | WorkflowValidationError | ScheduleAlreadyExistsError
   >
```

`TypedScheduleCreateOptions`:

| Field              | Type                                 | Required                         |
| ------------------ | ------------------------------------ | -------------------------------- |
| `scheduleId`       | `string`                             | yes                              |
| `spec`             | `ScheduleSpec`                       | yes                              |
| `args`             | `ClientInferInput<TWorkflow>`        | yes                              |
| `policies`         | `ScheduleOptions["policies"]`        | no                               |
| `state`            | `ScheduleOptions["state"]`           | no                               |
| `memo`             | `Record<string, unknown>`            | no — metadata on the _schedule_  |
| `searchAttributes` | `TypedSearchAttributeMap<TWorkflow>` | no — applied to each spawned run |
| `action`           | `TypedScheduleActionOverrides`       | no — applied to each spawned run |

`workflowType` and `taskQueue` come from the contract and are not settable.

`TypedScheduleActionOverrides` covers `workflowId`,
`workflowExecutionTimeout`, `workflowRunTimeout`, `workflowTaskTimeout`,
`retry`, `memo`, `staticDetails`, `staticSummary`.

::: tip Two memos
Top-level `memo` is metadata on the schedule; `action.memo` is attached to every
workflow it starts. Separate lifecycles, hence separate scopes.
:::

### `getHandle(scheduleId)`

Synchronously wraps an existing schedule id in a `TypedScheduleHandle`. No
server round-trip — a wrong id surfaces as `ScheduleNotFoundError` from the
handle's methods.

### `list(options?)`

```typescript
=> AsyncIterable<ScheduleSummary>
```

Passthrough of Temporal's `ScheduleClient.list`.

### `TypedScheduleHandle`

| Member              | Type                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `scheduleId`        | `string`                                                              |
| `pause(note?)`      | `AsyncResult<void, ScheduleNotFoundError>`                            |
| `unpause(note?)`    | `AsyncResult<void, ScheduleNotFoundError>`                            |
| `trigger(overlap?)` | `AsyncResult<void, ScheduleNotFoundError>`                            |
| `update(updateFn)`  | `AsyncResult<void, ScheduleNotFoundError \| WorkflowValidationError>` |
| `backfill(options)` | `AsyncResult<void, ScheduleNotFoundError>`                            |
| `delete()`          | `AsyncResult<void, ScheduleNotFoundError>`                            |
| `describe()`        | `AsyncResult<ScheduleDescription, ScheduleNotFoundError>`             |

The one anticipated failure — the schedule does not exist on the server — is
modeled. Any other failure is a technical fault on the defect channel with a
`RuntimeClientError` cause.

`update(updateFn)` is describe-modify-persist: the client fetches the current
description, hands it to `updateFn`, and persists what it returns. When the
updated action's `workflowType` is a declared workflow, its `args` **are**
validated against that workflow's input schema first — a mismatch surfaces as
`WorkflowValidationError` on the err channel and nothing is persisted. (An
action whose `workflowType` is not on the contract stays a passthrough.)
`updateFn` runs exactly once per call; a server-side conflict retries the
already-computed options rather than re-invoking it. `backfill` runs the
schedule's action over historical time ranges.

## Errors exported here

Setup / lifecycle: `RuntimeClientError`, `TechnicalError`.

Start phase: `WorkflowNotInContractError`, `WorkflowValidationError`,
`WorkflowAlreadyStartedError`.

Result phase: `WorkflowFailedError`, plus the first-class outcome errors
`WorkflowCancelledError`, `WorkflowTerminatedError`, `WorkflowTimeoutError`
(each keeps the original `TemporalFailure` as `cause`), and
`WorkflowExecutionNotFoundError`.

Interaction phase: `QueryValidationError`, `QueryFailedError`,
`SignalValidationError`, `UpdateValidationError`, `UpdateRejectedError`
(worker-side admission rejection), `UpdateFailedError` (admitted handler
failed).

Schedules: `ScheduleAlreadyExistsError`, `ScheduleNotFoundError`.

Plus `ContractError` and the types `TemporalFailure`, `AnyContractError`,
`ContractErrorUnion`, `WorkflowContractErrorsOf`, `WorkflowResultErrorsOf`.

### Tag constants

Every error above has a literal-typed `_tag` constant
(`WORKFLOW_FAILED_ERROR_TAG`, `UPDATE_REJECTED_ERROR_TAG`, …). Group the cases
that share a handler by listing their tags in one `.with(...)` arm — the
matcher's exhaustiveness check then forces you to widen the arm if a future
release adds a member to the union:

```typescript
import {
  WORKFLOW_CANCELLED_ERROR_TAG,
  WORKFLOW_FAILED_ERROR_TAG,
  WORKFLOW_TERMINATED_ERROR_TAG,
  WORKFLOW_TIMEOUT_ERROR_TAG,
} from "@temporal-contract/client";
import { P } from "unthrown";

result.match({
  ok: (value) => value,
  errCases: (matcher) =>
    matcher.with(
      P.tag(WORKFLOW_FAILED_ERROR_TAG),
      P.tag(WORKFLOW_CANCELLED_ERROR_TAG),
      P.tag(WORKFLOW_TERMINATED_ERROR_TAG),
      P.tag(WORKFLOW_TIMEOUT_ERROR_TAG),
      (error) => report(error),
    ),
  defect: (cause) => report(cause),
});
```

See the [errors reference](/reference/errors).

## Inference helpers

`ClientInferInput`, `ClientInferOutput`, `ClientInferSignal`,
`ClientInferQuery`, `ClientInferUpdate`, `ClientInferWorkflowSignals`,
`ClientInferWorkflowQueries`, `ClientInferWorkflowUpdates`

Use these to type a function around the contract without restating its shapes:

```typescript
import type { ClientInferInput } from "@temporal-contract/client";

function buildOrderArgs(): ClientInferInput<typeof orderContract.workflows.processOrder> {
  return { orderId: "ORD-1", customerId: "CUST-1", amount: 42 };
}
```

## Next

- [Errors reference](/reference/errors)
- [Schedule workflows](/how-to/schedule-workflows)
