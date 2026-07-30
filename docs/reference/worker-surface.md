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

`activityOptions` may be omitted only if every reachable activity is covered by
a contract-level `defaultOptions` or an `activityOptionsByName` entry.
Otherwise `declareWorkflow` throws at declaration time, listing the uncovered
activities. An unknown `workflowName` also fails at declaration time, listing
the contract's available workflow names.

The returned function carries `name === workflowName`, which is how Temporal
derives the workflow type.

Workflow input is **parsed on receive** here — the client validated the args
but transmitted the caller's original value, so a transforming schema applies
exactly once. The return value is validated before completion and transmitted
as-is; the client parses it on receive. See
[Validation boundaries](/explanation/validation-boundaries).

### `WorkflowContext`

The first argument to `implementation`.

#### `activities`

`Readonly<...>` map of every activity reachable from this workflow —
workflow-scoped plus global — flattened to one namespace.

Each returns a **plain value**, not a `Result`. Input is validated before the
call, output after. A failure throws.

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

#### `defineSignal(name, handler)`

```typescript
(signalName: K, handler: (args: Input) => void | Promise<void>) => void;
```

An incoming signal whose payload fails the schema is **dropped and logged**
(`log.warn` with the signal name and issues) — it never fails the execution.
A signal is fire-and-forget; any stale client can send one.

#### `defineQuery(name, handler)`

```typescript
(queryName: K, handler: (args: Input) => Output) => void;
```

Must be synchronous.

#### `defineUpdate(name, handler)`

```typescript
(updateName: K, handler: (args: Input) => Promise<Output>) => void;
```

Names are constrained to what the contract declares. Register handlers inside
the implementation so they can close over workflow state. For an input-less
definition (`defineSignal()`, `defineQuery({ output })`,
`defineUpdate({ output })`) the handler receives `undefined`.

Binding a name the contract does not declare — possible only from untyped
code — throws `ContractMisuseError`, failing the execution terminally instead
of hanging it in Workflow Task retries.

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

The `signals` map mirrors the client handle's: one sender per signal declared
on the child's contract entry. The payload is validated before sending — an
invalid payload fails early as `Err(ChildWorkflowError)` — and the child
parses it on receive.

#### `executeChildWorkflow(contract, workflowName, options)`

Starts and waits.

```typescript
=> AsyncResult<
     Output,
     ChildWorkflowError | ChildWorkflowCancelledError | ChildWorkflowNotFoundError
   >
```

`TypedChildWorkflowOptions` is Temporal's `ChildWorkflowOptions` without
`taskQueue` and `args`, plus a typed `args`.

#### `cancellableScope(fn)` / `nonCancellableScope(fn)`

```typescript
<T>(fn: () => T | Promise<T>) => AsyncResult<T, WorkflowCancelledError>;
```

`cancellableScope` surfaces cancellation as `Err(WorkflowCancelledError)`.
`nonCancellableScope` ignores outside cancellation for its duration — the way
to run cleanup that must not be interrupted.

In both, a **non-cancellation** throw is an unmodeled failure and rides the
defect channel, so the modeled error channel stays exactly one type.

#### `continueAsNew(...)`

```typescript
// same workflow
(args: Input, options?: TypedContinueAsNewOptions): Promise<never>;

// cross-contract
(contract, workflowName, args, options?): Promise<never>;
```

Args are validated against the destination workflow's input schema before
Temporal is called; on failure it throws `WorkflowInputValidationError`.
`TypedContinueAsNewOptions` is Temporal's `ContinueAsNewOptions` without
`workflowType` and `taskQueue`.

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
dropped and logged, never thrown (see `defineSignal` above).

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

TypeScript requires every activity in the contract to be implemented, and the
declaration **fails fast** at runtime too: a declared activity with no
implementation throws at declaration time (listing the missing names), and a
stray key — an implementation the contract never declared — throws
`ActivityDefinitionNotFoundError`.

### Activity implementation signature

```typescript
(
  args: WorkerInferInput<TActivity>,
  helpers: { errors: ContractErrorConstructors; context: TContext },
) => AsyncResult<WorkerInferOutput<TActivity>, ApplicationFailure | ContractError>;
```

The `helpers` argument is optional to consume.

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

### `qualifyFailure(type, options?)`

```typescript
function qualifyFailure(
  type: string,
  options?: { message?: string; nonRetryable?: boolean; details?: unknown[] },
): (error: unknown) => ApplicationFailure;
```

Builds an error mapper for `fromPromise`. An `Error` rejection keeps its message
and is preserved as `cause`; anything else falls back to `options.message`, then
`String(error)`.

::: warning Always wraps
Even an `ApplicationFailure` rejection is wrapped, guaranteeing the resulting
`type`. The consequence is that an inner failure's own `type` and
`nonRetryable: true` are masked — pass `{ nonRetryable: true }` yourself if it
must stay permanent.
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
`ValidationError`, plus the `ContractError` surface.

## `@temporal-contract/worker/worker`

### `createWorker(options)`

```typescript
function createWorker<TContract>(
  options: CreateWorkerOptions<TContract>,
): AsyncResult<Worker, never>;
```

`CreateWorkerOptions` is Temporal's `WorkerOptions` without `taskQueue` (taken
from the contract), plus `contract` and an optional `activities`.

**`activities` is optional.** Omit it for a workflow-only worker — one that
polls exclusively for Workflow Tasks, leaving activities to a separate worker
process on the same task queue. See
[Configure a worker](/how-to/configure-a-worker#run-a-workflow-only-worker).

**No modeled error.** Bundling failures, bad connections, and invalid options are
technical faults on the **defect** channel with a `TechnicalError` cause.
Inspect with `isDefect()` / `match({ defect })` / `recoverDefect`, or use
`.get()` to rethrow the original cause.

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
