# Validation boundaries

Where schemas run, why some data is validated twice, and what that buys.

## The map

```
┌─ Client process ───────────────────────────────────────┐
│  executeWorkflow(args)                                  │
│      │                                                  │
│      ├─▶ ① workflow input schema                        │
│      ▼                                                  │
└──────┼──────────────────────────────────────────────────┘
       │  network
┌──────▼─── Worker process ──────────────────────────────┐
│  workflow function                                      │
│      ├─▶ ② workflow input schema (again)               │
│      │                                                  │
│      │   context.activities.chargeCard(input)           │
│      │       ├─▶ ③ activity input schema                │
│      │       ▼   network                                │
│      │   activity implementation                        │
│      │       ├─▶ ④ activity input schema (again)        │
│      │       │   ... your code ...                      │
│      │       ├─▶ ⑤ activity output schema               │
│      │       ▼   network                                │
│      │       └─▶ ⑥ activity output schema (again)       │
│      │                                                  │
│      └─▶ ⑦ workflow output schema                       │
└──────┼──────────────────────────────────────────────────┘
       │  network
┌──────▼─── Client process ──────────────────────────────┐
│      └─▶ ⑧ workflow output schema (again)               │
└─────────────────────────────────────────────────────────┘
```

Signals, queries, and updates follow the same pattern: validated on the client
before dispatch and on the worker before the handler runs.

## Why validate twice

Points ①/② and ③/④ look redundant. They are not.

**The caller-side check is for diagnostics.** It catches bad data _before_ it
crosses the network, so you get a descriptive schema error naming the offending
field, at the call site, with a stack trace pointing at your code. Without it,
the same mistake surfaces as a deserialization failure inside a worker you may
not even own.

**The callee-side check is authoritative.** The worker cannot assume its caller
used this library. A workflow may be started by the Temporal CLI, the Web UI,
another SDK, or an older version of your own client. The contract is only a
real guarantee if the side that enforces it is the side that runs the code.

The cost is a schema parse against data that already passed one — negligible
next to a network round-trip.

## Fail fast, fail nowhere

The practical consequence is worth stating plainly. When client-side validation
rejects a call:

- no workflow was started;
- no worker was involved;
- no history was written;
- there is no partial state to clean up.

```typescript
const result = await client.executeWorkflow("processOrder", {
  workflowId: "order-1",
  args: { orderId: "ORD-1", customerId: "CUST-1", amount: -1 },
});
// Err(WorkflowValidationError) — nothing happened server-side
```

Contrast that with validating inside the workflow: the execution starts, records
history, fails, and leaves a failed execution to explain.

## Direction matters

Schemas can transform. `z.string().transform(Number)` accepts a string and
produces a number, so "the type" depends on which way you are looking.

| Perspective             | Passes                 | Receives                   |
| ----------------------- | ---------------------- | -------------------------- |
| Client → workflow       | schema **input** type  | schema **output** type     |
| Workflow implementation | schema **output** type | returns the **input** type |

That is why the contract package exports four inference primitives rather than
two: `ClientInferInput`, `ClientInferOutput`, `WorkerInferInput`,
`WorkerInferOutput`. The worker and client packages both build on them, which is
how a transforming schema stays correct on both sides instead of silently
disagreeing.

## What a failure produces

| Where                                | Error                                                                                               | Behaviour                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------- |
| Client, before dispatch              | `WorkflowValidationError`, `SignalValidationError`, `QueryValidationError`, `UpdateValidationError` | Returned on the `err` channel |
| Worker, entering a workflow          | `WorkflowInputValidationError`                                                                      | Thrown; terminal              |
| Worker, leaving a workflow           | `WorkflowOutputValidationError`                                                                     | Thrown; terminal              |
| Worker, entering/leaving an activity | `ActivityInputValidationError`, `ActivityOutputValidationError`                                     | Thrown; terminal              |
| Contract error payload               | `ContractErrorDataValidationError`                                                                  | Thrown; terminal              |

Worker-side validation errors extend Temporal's `ApplicationFailure` and are
marked **non-retryable**. This is the right default: a schema mismatch is
deterministic. Retrying the same payload against the same schema will fail
identically, so retrying would only burn attempts and delay the real signal.

All of them carry `issues` — the raw Standard Schema issue array — for
programmatic inspection, and a human-readable summary in `message`:

```typescript
import { summarizeIssues } from "@temporal-contract/contract";

if (result.isErr() && result.error instanceof WorkflowValidationError) {
  console.error(summarizeIssues(result.error.issues));
}
```

## Structure is validated too

`defineContract` validates the contract itself, at call time — not the data, the
_shape_:

- `taskQueue` present and non-empty
- at least one workflow
- every name a valid JavaScript identifier
- every schema slot Standard Schema compatible
- no activity-name collisions in the flat runtime namespace
- no unknown keys in `defaultOptions`

Because this runs at import time, a malformed contract fails when the process
starts rather than when a workflow first executes.

## Where middleware and interceptors sit

The two extension points sit on opposite sides of the boundary, and the
difference matters.

**Activity middleware runs inside it.** `invocation.input` is already validated,
and whatever the chain returns is still validated on the way out. If middleware
substitutes the input via `next({ input })`, the substitution is **re-validated**
— middleware cannot smuggle unvalidated data past the contract.

**Client interceptors run outside it.** They see the caller's raw, not-yet-validated
payload. A patch passed to `next({ input })` goes through exactly the same
validation as the original.

The invariant holds either way: nothing reaches an implementation without having
satisfied the contract.

The practical catch for interceptors is that a patched field must exist on the
schema. Injecting a `traceparent` the workflow's input schema does not declare
fails validation. Declare it on the contract, or carry it in `memo` /
`searchAttributes` instead.

## Any Standard Schema library

The contract accepts anything implementing
[Standard Schema](https://standardschema.dev/) — Zod, Valibot, ArkType — and
mixing them within one contract is fine.

The one constraint: **query schemas must validate synchronously.** Temporal
requires query handlers to complete synchronously, so async refinements cannot
work. Standard Schema does not expose the sync/async distinction at the type
level, so this is checked at runtime and throws if `~standard.validate` returns
a `Promise`.

## Next

- [The result model](/explanation/the-result-model)
- [Errors reference](/reference/errors)
- [Define a contract](/how-to/define-a-contract)
