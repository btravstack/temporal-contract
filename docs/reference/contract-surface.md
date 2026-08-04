# Contract surface

Everything exported from `@temporal-contract/contract`.

For generated per-symbol documentation, see the [API reference](/api/contract/).

## Builders

All builders are identity functions — they return their argument unchanged,
preserving its literal type for inference. Only `defineContract` performs
runtime validation.

### `defineContract(definition)`

```typescript
function defineContract<T extends ContractDefinition>(definition: T): T;
```

| Field        | Type                                 | Required | Description                                          |
| ------------ | ------------------------------------ | -------- | ---------------------------------------------------- |
| `taskQueue`  | `string`                             | yes      | Non-empty. The queue workers poll and clients target |
| `workflows`  | `Record<string, WorkflowDefinition>` | yes      | At least one workflow **or** one global activity     |
| `activities` | `Record<string, ActivityDefinition>` | no       | Global activities, reachable from every workflow     |

**Throws** `Error` when the structure is invalid. The check is a hand-rolled
structural validator — the contract package has no runtime schema-library
dependency. Checked at call time:

- `taskQueue` empty or missing
- neither a workflow nor a global activity is declared (an empty `workflows`
  is fine when at least one global activity exists — see activity-only
  contracts below)
- an unknown key at the contract root (strict — only the three fields above)
- any key that is not a valid JavaScript identifier (`/^[a-zA-Z_$][a-zA-Z0-9_$]*$/`)
- an `input`, `output`, or error `data` that is not Standard Schema compatible
- an activity name that collides across the flat namespace — global vs
  workflow-scoped, or two _different_ definitions under one name across
  workflows. Reusing the **same definition object** across workflows is
  allowed (one activity, not a collision); the collision message recommends
  hoisting shared activities to the global `activities` block
- a workflow name colliding with a global activity name (they share the root
  of the worker's implementations map)
- unknown keys inside `activityOptions`
- a **reserved name** — any workflow / activity / signal / query / update /
  search-attribute / error name starting with `__temporal_`, or the exact
  names `__stack_trace` / `__enhanced_stack_trace` (used internally by the
  Temporal SDK)
- an **invalid duration** in an `activityOptions` timeout / retry-interval —
  strings are validated against the `ms` grammar (`"30s"`, `"5 minutes"`,
  `"1.5h"`, or a long-form unit), so `"5 minutos"`, `""`, and `"abc"` throw at
  definition; a numeric duration must be a non-negative finite number of
  milliseconds

**Activity-only contracts are allowed.** `workflows` may be `{}` as long as at
least one global activity is declared — the "at least one workflow" rule above
relaxes when the contract exists purely to serve activities.

### `defineWorkflow(definition)`

| Field              | Type                                        | Required |
| ------------------ | ------------------------------------------- | -------- |
| `input`            | `AnySchema`                                 | yes      |
| `output`           | `AnySchema`                                 | yes      |
| `idempotency`      | `IdempotencyMode`                           | yes      |
| `activities`       | `Record<string, ActivityDefinition>`        | no       |
| `signals`          | `Record<string, SignalDefinition>`          | no       |
| `queries`          | `Record<string, QueryDefinition>`           | no       |
| `updates`          | `Record<string, UpdateDefinition>`          | no       |
| `searchAttributes` | `Record<string, SearchAttributeDefinition>` | no       |
| `errors`           | `Record<string, ErrorDefinition>`           | no       |

`idempotency` governs what happens when this workflow ID is started again
after a previous run has **closed** — `"once-per-id"` (`REJECT_DUPLICATE`),
`"retry-if-failed"` (`ALLOW_DUPLICATE_FAILED_ONLY` — re-runnable after any
Closed state other than Completed: Failed, Cancelled, Terminated, or
TimedOut), or `"allow-duplicate"` (`ALLOW_DUPLICATE`, Temporal's own
default). The client applies it to every start of this workflow, and the
worker applies it to every child-workflow start of it; an explicit per-call
`workflowIdReusePolicy` overrides it. `workflowIdConflictPolicy` — what to do
about a run that is already _open_ — stays a per-call client/worker option,
untouched by this field. See [Define a
contract](/how-to/define-a-contract#declare-idempotency).

### `defineActivity(definition)`

| Field             | Type                              | Required |
| ----------------- | --------------------------------- | -------- |
| `input`           | `AnySchema`                       | yes      |
| `output`          | `AnySchema`                       | yes      |
| `errors`          | `Record<string, ErrorDefinition>` | no       |
| `activityOptions` | `ContractActivityOptions`         | no       |

::: info Renamed in 8.0
The contract-level activity-options field is `activityOptions` (it was
`defaultOptions` before 8.0), and its type is `ContractActivityOptions` (it
was `ActivityDefaultOptions`). The type name is now distinct from Temporal's
own `ActivityOptions`, which is what the worker-side overrides take.
:::

### `defineSignal(definition?)`

| Field   | Type        | Required |
| ------- | ----------- | -------- |
| `input` | `AnySchema` | no       |

Signals return nothing, so there is no `output`.

Omit `input` (or the whole argument: `defineSignal()`) for a payload-less
signal — the definition then carries an `UndefinedInputSchema`, the handler
receives `undefined`, and the client-side payload argument is omittable.

### `defineQuery(definition)`

| Field    | Type        | Required |
| -------- | ----------- | -------- |
| `input`  | `AnySchema` | no       |
| `output` | `AnySchema` | yes      |

::: warning Synchronous validation only
Temporal requires query handlers to complete synchronously, so both schemas
must validate synchronously. Async refinements are not supported. Standard
Schema does not expose the distinction at the type level, so the worker checks
at runtime and fails the execution with a `ContractMisuseError` if
`~standard.validate` returns a `Promise`.
:::

Use `defineQuery({ output })` for a query with no parameters.

### `defineUpdate(definition)`

| Field    | Type        | Required |
| -------- | ----------- | -------- |
| `input`  | `AnySchema` | no       |
| `output` | `AnySchema` | yes      |

Update handlers may be asynchronous. `defineUpdate({ output })` declares an
argument-less update.

### `defineSearchAttribute(definition)`

| Field  | Type                  | Required |
| ------ | --------------------- | -------- |
| `kind` | `SearchAttributeKind` | yes      |

| `kind`           | TypeScript type |
| ---------------- | --------------- |
| `"TEXT"`         | `string`        |
| `"KEYWORD"`      | `string`        |
| `"INT"`          | `number`        |
| `"DOUBLE"`       | `number`        |
| `"BOOL"`         | `boolean`       |
| `"DATETIME"`     | `Date`          |
| `"KEYWORD_LIST"` | `string[]`      |

`TEXT` is tokenized and analyzed; `KEYWORD` matches exactly. Attributes must be
registered on the Temporal namespace before use.

## Option types

### `ErrorDefinition`

```typescript
type ErrorDefinition = {
  data?: AnySchema;
  message?: string;
  nonRetryable?: boolean;
};
```

| Field          | Effect                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------- |
| the map key    | Becomes `ApplicationFailure.type` on the wire                                                 |
| `data`         | Schema for the payload. Validated when raised and when rehydrated. Omit for a data-less error |
| `message`      | Default message. Overridable per instance                                                     |
| `nonRetryable` | `true` stops Temporal retrying. Default `false`                                               |

### `ContractActivityOptions`

A strict object — unknown keys are rejected at `defineContract` time.

```typescript
type ContractActivityOptions = {
  startToCloseTimeout?: DurationValue;
  scheduleToCloseTimeout?: DurationValue;
  scheduleToStartTimeout?: DurationValue;
  heartbeatTimeout?: DurationValue;
  retry?: ActivityRetryPolicy;
};

type ActivityRetryPolicy = {
  initialInterval?: DurationValue;
  maximumInterval?: DurationValue;
  backoffCoefficient?: number;
  maximumAttempts?: number;
  nonRetryableErrorTypes?: string[];
};

type DurationValue = string | number; // "30 seconds" | 30_000
```

Merge order, least to most specific: `declareWorkflow({ activityOptions })` →
`defineActivity({ activityOptions })` → `declareWorkflow({ activityOptionsByName })`.
See [Tune activity options](/how-to/tune-activity-options).

## Formatting helpers

### `formatIssue(issue)`

Renders one Standard Schema issue as a single readable line.

### `summarizeIssues(issues)`

Renders an array of issues as a compact summary, for error messages and logs.

```typescript
import { summarizeIssues } from "@temporal-contract/contract";

if (result.isErr() && result.error instanceof WorkflowValidationError) {
  console.error(summarizeIssues(result.error.issues));
}
```

## Errors

Exported from `@temporal-contract/contract/errors`, and re-exported by the
worker and client packages so you rarely import from here directly. (The
package **root** does not import `unthrown`, so the runtime error machinery
lives on this separate `/errors` entry; the root re-exports only the two tag
_constants_ below.)

- `TechnicalError` — infrastructure fault. Only ever a defect's `cause`, never
  in a modeled `E` channel
- `ContractError` — a declared domain error, carrying `errorName` and `data`
- `AnyContractError`, `ContractErrorUnion`, `ContractErrorInputUnion`,
  `ContractErrorConstructors`, `ContractErrorOptions`
- `ApplicationFailureLike` — the structural `{ type?, message?, details? }`
  shape the rehydration path reads off the wire (a superset of Temporal's
  `ApplicationFailure`)

### Tag constants and the wire marker

- `CONTRACT_ERROR_TAG` (`"@temporal-contract/ContractError"`) and
  `TECHNICAL_ERROR_TAG` — literal `_tag` constants, exported from **both** the
  package root and `/errors`, for `P.tag(...)` matching.
- `CONTRACT_ERROR_WIRE_MARKER` — the provenance marker written as
  `details[1] = { $tc: 1 }` when a contract error crosses the wire
  (`details[0]` is the validated data). A **data-less** declared error now
  requires this marker to rehydrate — closing the false positive where any
  `ApplicationFailure` sharing a matching `type` was surfaced as the typed
  error.

### `onRehydrationMiss(handler)`

A diagnostic hook fired when an inbound `ApplicationFailure` matches a declared
error's `type` but fails to rehydrate — data that does not validate, or a
data-less error missing the wire marker — so it degrades to a generic failure
instead. The handler receives a `RehydrationMiss` (exported) describing the
miss. Use it to alert on contract/producer drift.

See the [errors reference](/reference/errors).

## Types

### Contract shapes

`AnySchema`, `UndefinedInputSchema`, `ActivityDefinition`, `SignalDefinition`,
`QueryDefinition`, `UpdateDefinition`, `WorkflowDefinition`,
`AnyWorkflowDefinition`, `ContractDefinition`, `SearchAttributeDefinition`,
`SearchAttributeKind`, `SearchAttributeKindToType`, `IdempotencyMode`

`UndefinedInputSchema` is the Standard Schema type materialized by
`defineSignal` / `defineQuery` / `defineUpdate` when `input` is omitted —
validation only accepts `undefined`.

### Error inference

`ErrorDefinition`, `InferDeclaredErrors`, `InferErrorData`, `InferErrorDataInput`

`InferErrorData` gives the schema's **output** (post-transform) shape — what a
consumer receives. `InferErrorDataInput` gives the **input** (pre-transform)
shape — what a producer passes to the constructor.

::: info Renamed in 8.0
`DeclaredErrorsOf` is now `InferDeclaredErrors` (part of the `Infer*` naming
sweep).
:::

### Name extraction

`InferWorkflowNames`, `InferActivityNames`, `InferSignalNames`,
`InferQueryNames`, `InferUpdateNames`

::: info Renamed in 8.0
`SignalNamesOf` / `QueryNamesOf` / `UpdateNamesOf` are now `InferSignalNames` /
`InferQueryNames` / `InferUpdateNames`.
:::

### Direction-aware inference

`WorkerInferInput`, `WorkerInferOutput`, `ClientInferInput`, `ClientInferOutput`

Schemas can transform, so the type differs by direction. A client passes the
schema's _input_ type and receives its _output_ type; a worker receives the
_output_ type and returns something assignable to the _input_ type. These
primitives encode that and are shared by the worker and client packages.

## Next

- [Worker surface](/reference/worker-surface)
- [Client surface](/reference/client-surface)
- [Define a contract](/how-to/define-a-contract)
