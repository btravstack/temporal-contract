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
| `workflows`  | `Record<string, WorkflowDefinition>` | yes      | At least one entry                                   |
| `activities` | `Record<string, ActivityDefinition>` | no       | Global activities, reachable from every workflow     |

**Throws** `Error` when the structure is invalid. The check is a hand-rolled
structural validator — the contract package has no runtime schema-library
dependency. Checked at call time:

- `taskQueue` empty or missing
- `workflows` empty
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
- unknown keys inside `defaultOptions`

### `defineWorkflow(definition)`

| Field              | Type                                        | Required |
| ------------------ | ------------------------------------------- | -------- |
| `input`            | `AnySchema`                                 | yes      |
| `output`           | `AnySchema`                                 | yes      |
| `activities`       | `Record<string, ActivityDefinition>`        | no       |
| `signals`          | `Record<string, SignalDefinition>`          | no       |
| `queries`          | `Record<string, QueryDefinition>`           | no       |
| `updates`          | `Record<string, UpdateDefinition>`          | no       |
| `searchAttributes` | `Record<string, SearchAttributeDefinition>` | no       |
| `errors`           | `Record<string, ErrorDefinition>`           | no       |

### `defineActivity(definition)`

| Field            | Type                              | Required |
| ---------------- | --------------------------------- | -------- |
| `input`          | `AnySchema`                       | yes      |
| `output`         | `AnySchema`                       | yes      |
| `errors`         | `Record<string, ErrorDefinition>` | no       |
| `defaultOptions` | `ActivityDefaultOptions`          | no       |

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

### `ActivityDefaultOptions`

A strict object — unknown keys are rejected at `defineContract` time.

```typescript
type ActivityDefaultOptions = {
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
`defineActivity({ defaultOptions })` → `declareWorkflow({ activityOptionsByName })`.
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
worker and client packages so you rarely import from here directly.

- `TechnicalError` — infrastructure fault. Only ever a defect's `cause`, never
  in a modeled `E` channel
- `ContractError` — a declared domain error, carrying `errorName` and `data`
- `AnyContractError`, `ContractErrorUnion`, `ContractErrorInputUnion`,
  `ContractErrorConstructors`, `ContractErrorOptions`

See the [errors reference](/reference/errors).

## Types

### Contract shapes

`AnySchema`, `UndefinedInputSchema`, `ActivityDefinition`, `SignalDefinition`,
`QueryDefinition`, `UpdateDefinition`, `WorkflowDefinition`,
`AnyWorkflowDefinition`, `ContractDefinition`, `SearchAttributeDefinition`,
`SearchAttributeKind`, `SearchAttributeKindToType`

`UndefinedInputSchema` is the Standard Schema type materialized by
`defineSignal` / `defineQuery` / `defineUpdate` when `input` is omitted —
validation only accepts `undefined`.

### Error inference

`ErrorDefinition`, `DeclaredErrorsOf`, `InferErrorData`, `InferErrorDataInput`

`InferErrorData` gives the schema's **output** (post-transform) shape — what a
consumer receives. `InferErrorDataInput` gives the **input** (pre-transform)
shape — what a producer passes to the constructor.

### Name extraction

`InferWorkflowNames`, `InferActivityNames`, `SignalNamesOf`, `QueryNamesOf`,
`UpdateNamesOf`

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
