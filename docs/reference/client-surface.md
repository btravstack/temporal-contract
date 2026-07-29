# Client surface

Everything exported from `@temporal-contract/client`.

Generated per-symbol docs: [API reference](/api/client/).

The surface is split in two: `TypedClient` is **connection-scoped** — it owns
the underlying `Client`, the interceptor chain, and the escape hatch — and
hands out **contract-scoped** `ContractClient`s via `for()`.

## `TypedClient`

### `TypedClient.create(options)`

```typescript
static create(options: {
  client: Client;                              // from @temporalio/client
  interceptors?: readonly ClientInterceptor[]; // outermost first
}): AsyncResult<TypedClient, never>;
```

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
calling it per request is free. Interceptors are inherited from the root.

```typescript
const orders = client.for(orderContract);
const shipments = client.for(shipmentContract); // same connection, second contract
```

### `raw`

The underlying `@temporalio/client` `Client` — the escape hatch for anything
the typed surface does not cover yet (`raw.workflow.list(...)`,
`raw.workflow.count(...)`). Calls made through `raw` bypass contract
validation and the interceptor chain.

## `ContractClient<TContract>`

Obtained from `TypedClient.for` — its constructor is not public API. Written
as an annotation: `ContractClient<typeof orderContract>`.

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
     | WorkflowExecutionNotFoundError
   >
```

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

| Member                     | Type                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `workflowId`               | `string`                                                                                                                      |
| `runId`                    | `string \| undefined` — the bound run, when known                                                                             |
| `firstExecutionRunId`      | `string \| undefined` — first run of the chain, when known                                                                    |
| `queries`                  | `Record<QueryName, (args) => AsyncResult<Output, QueryValidationError \| WorkflowExecutionNotFoundError>>`                    |
| `signals`                  | `Record<SignalName, (args) => AsyncResult<void, SignalValidationError \| WorkflowExecutionNotFoundError>>`                    |
| `updates`                  | `Record<UpdateName, (args) => AsyncResult<Output, UpdateValidationError \| WorkflowExecutionNotFoundError>>`                  |
| `startUpdate(name, opts?)` | `AsyncResult<TypedWorkflowUpdateHandle<TUpdate>, UpdateValidationError \| WorkflowExecutionNotFoundError>`                    |
| `result()`                 | `AsyncResult<Output, ContractErrorUnion \| WorkflowValidationError \| WorkflowFailedError \| WorkflowExecutionNotFoundError>` |
| `terminate(reason?)`       | `AsyncResult<void, WorkflowExecutionNotFoundError>`                                                                           |
| `cancel()`                 | `AsyncResult<void, WorkflowExecutionNotFoundError>`                                                                           |
| `describe()`               | `AsyncResult<WorkflowExecutionDescription, WorkflowExecutionNotFoundError>`                                                   |
| `fetchHistory()`           | `AsyncResult<History, WorkflowExecutionNotFoundError>`                                                                        |

`queries`, `signals`, and `updates` are generated from the contract — only the
declared operations exist, with their schemas' types. Payloads are validated
before dispatch and parsed by the worker on receive; the payload argument is
omittable for input-less definitions. Results (queries, updates, `result()`)
are parsed on receive against the contract's output schema.

The `updates` map executes and waits (Temporal's `executeUpdate`);
`startUpdate` starts without waiting and returns a handle.

`result()` surfaces a declared contract error as a `ContractError` instead of a
generic `WorkflowFailedError`.

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

| Member              | Type                                                      |
| ------------------- | --------------------------------------------------------- |
| `scheduleId`        | `string`                                                  |
| `pause(note?)`      | `AsyncResult<void, ScheduleNotFoundError>`                |
| `unpause(note?)`    | `AsyncResult<void, ScheduleNotFoundError>`                |
| `trigger(overlap?)` | `AsyncResult<void, ScheduleNotFoundError>`                |
| `update(updateFn)`  | `AsyncResult<void, ScheduleNotFoundError>`                |
| `backfill(options)` | `AsyncResult<void, ScheduleNotFoundError>`                |
| `delete()`          | `AsyncResult<void, ScheduleNotFoundError>`                |
| `describe()`        | `AsyncResult<ScheduleDescription, ScheduleNotFoundError>` |

The one anticipated failure — the schedule does not exist on the server — is
modeled. Any other failure is a technical fault on the defect channel with a
`RuntimeClientError` cause.

`update(updateFn)` is fetch-modify-persist: Temporal hands `updateFn` the
current description and persists what it returns. It may be invoked more than
once on conflict — keep it pure. The action's `workflowType` / `taskQueue` /
`args` are **not** re-validated against the contract here; prefer delete +
`create` for contract-level changes. `backfill` runs the schedule's action
over historical time ranges.

## Interceptors

### `ClientInterceptor`

```typescript
type ClientInterceptor = (
  args: ClientInterceptorArgs,
  next: ClientInterceptorNext,
) => AsyncResult<unknown, ClientCallError>;
```

Passed to `TypedClient.create({ interceptors })`, inherited by every
`ContractClient` the root hands out. Wraps operations **outside** the
validation pipeline, but a patched input is validated exactly like the
caller's original.

### `ClientInterceptorArgs`

Discriminated on `operation`:

| `operation`                            | Fields                                        |
| -------------------------------------- | --------------------------------------------- |
| `"startWorkflow"`, `"executeWorkflow"` | `workflowName`, `workflowId`, `input`         |
| `"signalWithStart"`                    | the above, plus `signalName`, `signalInput`   |
| `"signal"`, `"query"`, `"update"`      | `workflowName`, `workflowId`, `name`, `input` |

`input` is the raw, not-yet-validated payload.

### `ClientInterceptorNext`

```typescript
(patch?: { input?: unknown; signalInput?: unknown }) => AsyncResult<unknown, ClientCallError>;
```

The patch shallow-merges over the invocation. Calling `next` again re-runs the
rest of the chain. Returning without calling it short-circuits.

### `ClientCallError`

The widened union the chain is typed against — every modeled error a typed-client
operation can surface. Each public method narrows it back at the boundary.

Note it does **not** include `RuntimeClientError`, which rides the defect
channel.

## Errors exported here

`RuntimeClientError`, `WorkflowNotInContractError`,
`WorkflowAlreadyStartedError`, `WorkflowExecutionNotFoundError`,
`WorkflowFailedError`, `WorkflowValidationError`, `QueryValidationError`,
`SignalValidationError`, `UpdateValidationError`, `ScheduleAlreadyExistsError`,
`ScheduleNotFoundError`, `TechnicalError`, `ContractError`.

Plus the types `TemporalFailure`, `AnyContractError`, `ContractErrorUnion`,
`WorkflowContractErrorsOf`.

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
- [Intercept client calls](/how-to/intercept-client-calls)
- [Schedule workflows](/how-to/schedule-workflows)
