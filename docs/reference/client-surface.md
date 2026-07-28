# Client surface

Everything exported from `@temporal-contract/client`.

Generated per-symbol docs: [API reference](/api/client/).

## `TypedClient`

### `TypedClient.create(options)`

```typescript
static create<TContract>(options: {
  contract: TContract;
  client: Client;                              // from @temporalio/client
  interceptors?: readonly ClientInterceptor[]; // outermost first
}): AsyncResult<TypedClient<TContract>, never>;
```

**No modeled error.** Setup faults ride the defect channel with a
`TechnicalError` cause. `.get()` rethrows the original cause:

```typescript
const client = await TypedClient.create({ contract, client: temporalClient }).get();
```

### `TypedClient.createOrThrow(contract, client, interceptors?)`

Synchronous, throwing variant.

### `executeWorkflow(workflowName, options)`

Starts and waits.

```typescript
=> AsyncResult<
     Output,
     | ContractErrorUnion            // when the workflow declares errors
     | WorkflowNotFoundError
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
     | WorkflowNotFoundError
     | WorkflowValidationError
     | WorkflowAlreadyStartedError
   >
```

### `signalWithStart(workflowName, options)`

Starts the workflow if it does not exist, and delivers the signal either way.

```typescript
=> AsyncResult<
     TypedWorkflowHandleWithSignaledRunId<TWorkflow>,
     | WorkflowNotFoundError
     | WorkflowValidationError
     | SignalValidationError
     | WorkflowAlreadyStartedError
   >
```

The returned handle adds `signaledRunId` — the run that received the signal,
which is not necessarily a newly started one.

### `getHandle(workflowName, workflowId)`

Binds to an existing execution.

```typescript
=> AsyncResult<TypedWorkflowHandle<TWorkflow>, WorkflowNotFoundError>
```

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
and the rest pass through.

### `TypedSignalWithStartOptions`

The above, plus:

| Field        | Type                          |
| ------------ | ----------------------------- |
| `signalName` | a signal name on the workflow |
| `signalArgs` | `ClientInferInput<TSignal>`   |

::: warning It is `signalName`, not `signal`
:::

## `TypedWorkflowHandle`

| Member               | Type                                                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `workflowId`         | `string`                                                                                                                      |
| `queries`            | `Record<QueryName, (args) => AsyncResult<Output, QueryValidationError \| WorkflowExecutionNotFoundError>>`                    |
| `signals`            | `Record<SignalName, (args) => AsyncResult<void, SignalValidationError \| WorkflowExecutionNotFoundError>>`                    |
| `updates`            | `Record<UpdateName, (args) => AsyncResult<Output, UpdateValidationError \| WorkflowExecutionNotFoundError>>`                  |
| `result()`           | `AsyncResult<Output, ContractErrorUnion \| WorkflowValidationError \| WorkflowFailedError \| WorkflowExecutionNotFoundError>` |
| `terminate(reason?)` | `AsyncResult<void, WorkflowExecutionNotFoundError>`                                                                           |
| `cancel()`           | `AsyncResult<void, WorkflowExecutionNotFoundError>`                                                                           |
| `describe()`         | `AsyncResult<WorkflowExecutionDescription, WorkflowExecutionNotFoundError>`                                                   |
| `fetchHistory()`     | `AsyncResult<History, WorkflowExecutionNotFoundError>`                                                                        |

`queries`, `signals`, and `updates` are generated from the contract — only the
declared operations exist, with their schemas' types. Payloads are validated on
both sides.

`result()` surfaces a declared contract error as a `ContractError` instead of a
generic `WorkflowFailedError`.

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

Reached as `client.schedule`.

### `create(workflowName, options)`

```typescript
=> AsyncResult<TypedScheduleHandle, WorkflowNotFoundError | WorkflowValidationError>
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

### `TypedScheduleHandle`

| Member              | Type                                      |
| ------------------- | ----------------------------------------- |
| `scheduleId`        | `string`                                  |
| `pause(note?)`      | `AsyncResult<void, never>`                |
| `unpause(note?)`    | `AsyncResult<void, never>`                |
| `trigger(overlap?)` | `AsyncResult<void, never>`                |
| `delete()`          | `AsyncResult<void, never>`                |
| `describe()`        | `AsyncResult<ScheduleDescription, never>` |

All have an empty error channel — a failed schedule operation is a technical
fault on the defect channel with a `RuntimeClientError` cause.

## Interceptors

### `ClientInterceptor`

```typescript
type ClientInterceptor = (
  args: ClientInterceptorArgs,
  next: ClientInterceptorNext,
) => AsyncResult<unknown, ClientCallError>;
```

Wraps operations **outside** the validation pipeline, but a patched input is
validated exactly like the caller's original.

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

`RuntimeClientError`, `WorkflowNotFoundError`, `WorkflowAlreadyStartedError`,
`WorkflowExecutionNotFoundError`, `WorkflowFailedError`,
`WorkflowValidationError`, `QueryValidationError`, `SignalValidationError`,
`UpdateValidationError`, `TechnicalError`, `ContractError`.

Plus the types `TemporalFailure`, `AnyContractError`, `ContractErrorUnion`,
`WorkflowContractErrorsOf`.

See the [errors reference](/reference/errors).

## Inference helpers

`ClientInferInput`, `ClientInferOutput`, `ClientInferWorkflow`,
`ClientInferActivity`, `ClientInferSignal`, `ClientInferQuery`,
`ClientInferUpdate`, `ClientInferWorkflows`, `ClientInferActivities`,
`ClientInferWorkflowActivities`, `ClientInferWorkflowSignals`,
`ClientInferWorkflowQueries`, `ClientInferWorkflowUpdates`,
`ClientInferWorkflowContextActivities`

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
