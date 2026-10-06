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
  onRehydrationMiss?: (miss: RehydrationMiss) => void;
}): AsyncResult<TypedClient, never>;
```

The options bag is the exported `CreateClientOptions`. `onRehydrationMiss` is
called when a failure whose `type` names a declared contract error does **not**
rehydrate into it (its payload fails the declared schema, or a data-less error
lacks the wire marker) and degrades to `WorkflowFailedError` — a sign of schema
drift between client and worker. A throwing hook is swallowed; the library
does not log on its own, so wire your logger here.

**No modeled error.** A connection that cannot be established rides the defect
channel with a `TechnicalError` cause. `.get()` rethrows the original cause:

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

Starts and waits — exactly `startWorkflow(...)` followed by `handle.result()`,
so result-phase errors carry the started workflow ID (derived or passed).

```typescript
=> AsyncResult<
     Output,
     | ContractErrorUnion            // when the workflow declares errors
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
     | WorkflowValidationError
     | WorkflowAlreadyStartedError
   >
```

The handle follows the run chain rather than pinning a run: its `runId` is
`undefined`, and `firstExecutionRunId` is the run just started.

### `signalWithStart(workflowName, options)`

Starts the workflow if it does not exist, and delivers the signal either way.

```typescript
=> AsyncResult<
     TypedWorkflowHandleWithSignaledRunId<TWorkflow>,
     | WorkflowValidationError
     | SignalValidationError
     | WorkflowAlreadyStartedError
   >
```

The returned handle adds `signaledRunId` — the run that received the signal,
which is not necessarily a newly started one. `workflowId` is enforced as on
`startWorkflow`: forbidden for a workflow whose contract derives it, required
otherwise.

### `executeUpdateWithStart(workflowName, options)`

Starts the workflow (or, under `workflowIdConflictPolicy: "USE_EXISTING"`,
reuses the running one) and sends it an update in one request, waiting for the
update's result — Temporal's `executeUpdateWithStart`. Both the workflow
`args` and the `updateArgs` are validated before anything is sent; the
update's result is parsed against its output schema.

```typescript
=> AsyncResult<
     UpdateOutput,
     | WorkflowValidationError
     | UpdateValidationError
     | WorkflowAlreadyStartedError
     | UpdateRejectedError
     | UpdateFailedError
     | UpdateRpcTimeoutOrCancelledError
   >
```

The options are `TypedUpdateWithStartOptions`: the start options plus
`workflowIdConflictPolicy` (required by Temporal), `updateName`, `updateArgs`
(omittable when the update's input schema accepts `undefined`), and an optional
`updateId`. To reach the workflow afterwards, `getHandle` it by ID.

### `workflowIdFor(workflowName, input)`

```typescript
=> AsyncResult<string, WorkflowValidationError>
```

The workflow ID the contract derives for `input` — the same validation and
derivation a start runs, without starting anything. Only callable for
workflows whose contract declares `workflowId` (the exported
`DerivedIdWorkflowName<TContract>`):

```typescript
const handle = await orders
  .workflowIdFor("processOrder", { orderId: "ORD-1" })
  .map((workflowId) => orders.getHandle("processOrder", workflowId));
```

### `getHandle(workflowName, workflowId, options?)`

Binds to an existing execution. **Synchronous and infallible**, like
Temporal's `getHandle` — no I/O is involved, so it returns the handle itself:

```typescript
=> TypedWorkflowHandle<TWorkflow>
```

Whether the execution exists is answered lazily, by the handle's methods, as
`WorkflowExecutionNotFoundError`.

`TypedGetHandleOptions` is Temporal's `GetWorkflowHandleOptions` (minus
`followRuns` — the handle always follows the run chain, so `result()` never
meets an unmodeled `WorkflowContinuedAsNewError`) plus `runId`:

| Field                 | Effect                                                                |
| --------------------- | --------------------------------------------------------------------- |
| `runId`               | Bind to a specific execution instead of the latest                    |
| `firstExecutionRunId` | Chain interlock — mutating methods refuse to cross into another chain |

::: tip Undeclared names are defects
Workflow, signal, and update names are constrained to the contract's
declarations at the type level. A name that slips past the types (a cast, an
untyped call) is a **defect** carrying a `TechnicalError` with a direct
message — `getHandle` and `getUpdateHandle` throw it — not a modeled `Err`.
:::

### `schedule`

A `TypedScheduleClient<TContract>`. See below.

## Option types

### `TypedWorkflowStartOptions`

Temporal's `WorkflowStartOptions` without the fields the contract owns —
`taskQueue`, `args`, `searchAttributes`, `typedSearchAttributes`, `workflowId`,
`workflowIdReusePolicy` (set from the workflow's `startPolicy`), and
`followRuns` (handles always follow the run chain) — plus:

| Field              | Type                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------ |
| `workflowId`       | `string` — required, or forbidden (`never`) when the contract derives it             |
| `args`             | `ClientInferInput<TWorkflow>`                                                        |
| `searchAttributes` | `TypedSearchAttributeMap<TWorkflow>` (optional; value kinds also checked at runtime) |

`workflowExecutionTimeout`, `workflowRunTimeout`, `retry`, `memo`, and the rest
pass through. `args` is omittable when the workflow's input schema accepts
`undefined`. The contract-owned fields are applied last, so not even an
explicit `undefined` smuggled past the types overrides them. A search
attribute that is undeclared, or whose value does not match its declared
`kind`, is a defect (`RuntimeClientError` cause) rather than a silently
mis-indexed workflow.

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

| Member                      | Type                                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflowId`                | `string`                                                                                                                                                                                                    |
| `runId`                     | `string \| undefined` — the run passed to `getHandle`; `undefined` on start handles, which follow the chain                                                                                                 |
| `firstExecutionRunId`       | `string \| undefined` — first run of the chain, when known                                                                                                                                                  |
| `raw`                       | the underlying `@temporalio/client` `WorkflowHandle` — escape hatch; bypasses validation                                                                                                                    |
| `queries`                   | `Record<QueryName, (args) => AsyncResult<Output, QueryValidationError \| QueryFailedError \| WorkflowExecutionNotFoundError>>`                                                                              |
| `signals`                   | `Record<SignalName, (args) => AsyncResult<void, SignalValidationError \| WorkflowExecutionNotFoundError>>`                                                                                                  |
| `updates`                   | `Record<UpdateName, (args, { updateId }?) => AsyncResult<Output, UpdateValidationError \| UpdateRejectedError \| UpdateFailedError \| UpdateRpcTimeoutOrCancelledError \| WorkflowExecutionNotFoundError>>` |
| `startUpdate(name, opts?)`  | `AsyncResult<TypedWorkflowUpdateHandle<TUpdate>, UpdateValidationError \| UpdateRpcTimeoutOrCancelledError \| WorkflowExecutionNotFoundError>`                                                              |
| `getUpdateHandle(name, id)` | `TypedWorkflowUpdateHandle<TUpdate>` — synchronous; reattaches to an update already sent, by `updateId`                                                                                                     |
| `result()`                  | `AsyncResult<Output, ContractErrorUnion \| WorkflowValidationError \| WorkflowFailedError \| WorkflowCancelledError \| WorkflowTerminatedError \| WorkflowTimeoutError \| WorkflowExecutionNotFoundError>`  |
| `terminate(reason?)`        | `AsyncResult<void, WorkflowExecutionNotFoundError>`                                                                                                                                                         |
| `cancel()`                  | `AsyncResult<void, WorkflowExecutionNotFoundError>`                                                                                                                                                         |
| `describe()`                | `AsyncResult<WorkflowExecutionDescription, WorkflowExecutionNotFoundError>`                                                                                                                                 |
| `fetchHistory()`            | `AsyncResult<History, WorkflowExecutionNotFoundError>`                                                                                                                                                      |

`queries`, `signals`, and `updates` are generated from the contract — only the
declared operations exist, with their schemas' types. Payloads are validated
before dispatch and parsed by the worker on receive; the payload argument is
omittable for input-less definitions. Results (queries, updates, `result()`)
are parsed on receive against the contract's output schema.

The `updates` map executes and waits (Temporal's `executeUpdate`); its
optional second argument carries an `updateId` for deduplication and
reattachment. `startUpdate` starts without waiting and returns a handle once
the update is accepted **or rejected** — so its own error channel is only
input validation, a timed-out/cancelled update call, or a missing execution; a
worker-side admission rejection (`UpdateRejectedError`) or a failed admitted
handler (`UpdateFailedError`) surfaces on the update handle's `result()`. A
query with no registered handler, or one whose handler threw, surfaces as
`QueryFailedError` (Temporal's `QueryRejectedError` included). All are modeled
`Err`s — before 8.0 they leaked as defects.

`result()` surfaces a declared contract error as a `ContractError` instead of a
generic `WorkflowFailedError`, and a cancelled / terminated / timed-out
execution as the first-class `WorkflowCancelledError` / `WorkflowTerminatedError`
/ `WorkflowTimeoutError` (each keeps the original `TemporalFailure` as `cause`).
The failure-to-`ContractError` rehydration reads the wire failure through the
`ApplicationFailureLike` shape (exported from
[`@temporal-contract/contract/errors`](/reference/contract-surface#tag-constants-and-the-wire-marker)).

### `TypedWorkflowUpdateHandle`

Returned by `startUpdate` and `getUpdateHandle`:

| Member          | Type                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `updateId`      | `string`                                                                                                                                                       |
| `workflowId`    | `string`                                                                                                                                                       |
| `workflowRunId` | `string \| undefined`                                                                                                                                          |
| `result()`      | `AsyncResult<Output, UpdateValidationError \| UpdateRejectedError \| UpdateFailedError \| UpdateRpcTimeoutOrCancelledError \| WorkflowExecutionNotFoundError>` |

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
     WorkflowValidationError | ScheduleAlreadyExistsError
   >
```

`TypedScheduleCreateOptions`:

| Field              | Type                                 | Required                                                              |
| ------------------ | ------------------------------------ | --------------------------------------------------------------------- |
| `scheduleId`       | `string`                             | yes                                                                   |
| `spec`             | `ScheduleSpec`                       | yes                                                                   |
| `args`             | `ClientInferInput<TWorkflow>`        | yes — unless the schema accepts `undefined` (then sent as empty args) |
| `policies`         | `ScheduleOptions["policies"]`        | no                                                                    |
| `state`            | `ScheduleOptions["state"]`           | no                                                                    |
| `memo`             | `Record<string, unknown>`            | no — metadata on the _schedule_                                       |
| `searchAttributes` | `TypedSearchAttributeMap<TWorkflow>` | no — applied to each spawned run                                      |
| `action`           | `TypedScheduleActionOverrides`       | no — applied to each spawned run                                      |

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

Passthrough of Temporal's `ScheduleClient.list`, not filtered to this
contract. The one method outside the Result discipline: a page fetch that fails
**throws** from the `for await` loop, as Temporal's does — wrap the loop in your
own boundary (`fromPromise`) when you need an `AsyncResult`.

### `TypedScheduleHandle`

| Member              | Type                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `scheduleId`        | `string`                                                              |
| `raw`               | the underlying `ScheduleHandle` — escape hatch; bypasses validation   |
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
updated action's `workflowType` is a declared workflow, the action is
re-checked the way `create` checks it before anything is persisted: its `args`
against the workflow's input schema (a mismatch is `WorkflowValidationError` on
the err channel), its search attributes against the declared names and kinds,
and its `taskQueue` against the contract's (either of those is a
misconfiguration, so a defect). (An action whose `workflowType` is not on the
contract stays a passthrough.)
`updateFn` runs exactly once per call; a server-side conflict retries the
already-computed options rather than re-invoking it. `backfill` runs the
schedule's action over historical time ranges.

## Errors exported here

Setup / lifecycle: `RuntimeClientError`, `TechnicalError`.

Start phase: `WorkflowValidationError`, `WorkflowAlreadyStartedError`.

Result phase: `WorkflowFailedError` (with Temporal's `retryState`), plus the first-class outcome errors
`WorkflowCancelledError`, `WorkflowTerminatedError`, `WorkflowTimeoutError`
(each keeps the original `TemporalFailure` as `cause`), and
`WorkflowExecutionNotFoundError`.

Interaction phase: `QueryValidationError`, `QueryFailedError`,
`SignalValidationError`, `UpdateValidationError`, `UpdateRejectedError`
(worker-side admission rejection), `UpdateFailedError` (admitted handler
failed), `UpdateRpcTimeoutOrCancelledError` (the update call timed out or was
cancelled — Temporal's `WorkflowUpdateRPCTimeoutOrCancelledError`).

Schedules: `ScheduleAlreadyExistsError`, `ScheduleNotFoundError`.

Plus `ContractError`, `CONTRACT_ERROR_TAG`, and the types `TemporalFailure`,
`AnyContractError`, `ContractErrorUnion`, `RehydrationMiss`,
`WorkflowContractErrorsOf`, `WorkflowResultErrorsOf`.

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

### Pattern groups

For the common unions, ready-made pattern arrays spread into one arm:

| Constant                    | Covers                                                                    |
| --------------------------- | ------------------------------------------------------------------------- |
| `WORKFLOW_START_PATTERNS`   | `startWorkflow` (`signalWithStart` adds `SignalValidationError`)          |
| `WORKFLOW_RESULT_PATTERNS`  | `handle.result()`, minus the workflow's declared errors                   |
| `WORKFLOW_EXECUTE_PATTERNS` | `executeWorkflow`, minus the workflow's declared errors                   |
| `WORKFLOW_STOPPED_PATTERNS` | the three first-class stopped outcomes (cancelled, terminated, timed out) |
| `SIGNAL_PATTERNS`           | `handle.signals.*`                                                        |
| `QUERY_PATTERNS`            | `handle.queries.*`                                                        |
| `UPDATE_PATTERNS`           | `handle.updates.*` and an update handle's `result()`                      |
| `SCHEDULE_CREATE_PATTERNS`  | `schedule.create`                                                         |

A workflow's declared errors are deliberately left out, so the matcher still
forces an arm for them (`P.tag(CONTRACT_ERROR_TAG)`, or one per name):

```typescript
import { CONTRACT_ERROR_TAG, WORKFLOW_EXECUTE_PATTERNS } from "@temporal-contract/client";
import { P } from "unthrown";

result.match({
  ok: (output) => output,
  errCases: (matcher) =>
    matcher
      .with(P.tag(CONTRACT_ERROR_TAG), (error) => report(error.errorName))
      .with(...WORKFLOW_EXECUTE_PATTERNS, (error) => report(error)),
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
