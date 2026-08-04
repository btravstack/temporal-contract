# Validation boundaries

Where schemas run, why both sides of a hop run one, and what that buys.

## The map

Every boundary follows one rule: **validate on send, parse on receive.** The
sender runs the schema to fail early but transmits the caller's _original_
value; the receiver parses, and the parsed value is what the handler sees.

```
┌─ Client process ───────────────────────────────────────┐
│  executeWorkflow(args)                                  │
│      │                                                  │
│      ├─▶ ① validate workflow input   (send original)    │
│      ▼                                                  │
└──────┼──────────────────────────────────────────────────┘
       │  network
┌──────▼─── Worker process ──────────────────────────────┐
│  workflow function                                      │
│      ├─▶ ② parse workflow input     (handler gets it)   │
│      │                                                  │
│      │   context.activities.chargeCard(input)           │
│      │       ├─▶ ③ validate activity input (send orig.) │
│      │       ▼   network                                │
│      │   activity implementation                        │
│      │       ├─▶ ④ parse activity input                 │
│      │       │   ... your code ...                      │
│      │       ├─▶ ⑤ validate activity output (send orig.)│
│      │       ▼   network                                │
│      │       └─▶ ⑥ parse activity output                │
│      │                                                  │
│      └─▶ ⑦ validate workflow output  (send original)    │
└──────┼──────────────────────────────────────────────────┘
       │  network
┌──────▼─── Client process ──────────────────────────────┐
│      └─▶ ⑧ parse workflow output                        │
└─────────────────────────────────────────────────────────┘
```

Signals, queries, updates, and child workflows follow the same pattern:
validated on the sending side before dispatch, parsed on the receiving side
before the handler (or caller) sees the value.

## Why both sides run the schema

Points ①/② and ③/④ look redundant. They are not — they do different jobs.

**The send-side check is for diagnostics.** It catches bad data _before_ it
crosses the network, so you get a descriptive schema error naming the offending
field, at the call site, with a stack trace pointing at your code. Without it,
the same mistake surfaces as a deserialization failure inside a worker you may
not even own. Its parsed result is deliberately **discarded** — the wire
carries the original value.

**The receive-side parse is authoritative.** The worker cannot assume its
caller used this library. A workflow may be started by the Temporal CLI, the
Web UI, another SDK, or an older version of your own client. The contract is
only a real guarantee if the side that enforces it is the side that runs the
code.

**Parsing once is what keeps transforms correct.** Schemas can transform —
`z.coerce.date()`, `.transform(...)`, `.default(...)`. If both sides applied
the parse and the wire carried the parsed value, every transform would run
twice, silently corrupting data (a date coerced twice, a default applied to an
already-defaulted object). Because the sender transmits the original and only
the receiver's parse "counts", **each transform applies exactly once per
boundary**. It also means what travels the wire — and what you see in the
Temporal Web UI or a raw history export — is the sender's original value.

The cost is one extra schema run per hop — negligible next to a network round
trip.

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
| Worker, receiving a signal           | —                                                                                                   | Signal dropped; `log.warn`    |
| Contract error payload               | `ContractErrorDataValidationError`                                                                  | Thrown; terminal              |

Worker-side validation errors extend Temporal's `ApplicationFailure` and are
marked **non-retryable**. This is the right default: a schema mismatch is
deterministic. Retrying the same payload against the same schema will fail
identically, so retrying would only burn attempts and delay the real signal.

The signal row is the deliberate exception. A signal is a fire-and-forget
message any stale client can send; failing the whole execution over one
malformed payload would let any sender kill any workflow. The worker drops the
signal and logs a warning (via `@temporalio/workflow`'s replay-aware
`log.warn`, with the signal name and the schema issues) — the execution
continues untouched. Client-side, a malformed signal still fails early with
`SignalValidationError` before dispatch.

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
_shape_ (a hand-rolled structural check; the contract package has no runtime
schema-library dependency):

- `taskQueue` present and non-empty
- at least one workflow _or_ global activity (activity-only contracts are valid
  — a dedicated activity-pool worker needs no workflows)
- no unknown keys at the contract root (strict — only `taskQueue`,
  `workflows`, `activities`)
- every name a valid JavaScript identifier, and not a Temporal-reserved name
  (the `__temporal_` prefix, `__stack_trace`, `__enhanced_stack_trace`)
- every duration option a valid `ms` string (`"5 minutes"`, `"30s"`) — a typo
  like `"5 minutos"` fails here, not at the worker
- every schema slot Standard Schema compatible
- no activity-name collisions in the flat runtime namespace — reusing the
  _same_ definition object across workflows is fine (that is one activity, not
  a collision); two different definitions under one name is rejected, with a
  hint to hoist the shared activity to the global `activities` block
- no workflow name colliding with a global activity name (they share the root
  of the worker's implementations map)
- no unknown keys in `activityOptions`

Because this runs at import time, a malformed contract fails when the process
starts rather than when a workflow first executes.

Inside the workflow sandbox, contract misuse throws `ContractMisuseError`, a
non-retryable `ApplicationFailure` — but what that buys depends on **when**
the throw happens, not just what class it is.

Binding a handler for an undeclared signal/query/update, or using an
async-validating query/update-input schema, is caught from inside the
running `implementation` — `handleSignal`/`handleQuery`/`handleUpdate`
execute there, after Temporal has already invoked the workflow function. A
throw at that point fails the execution terminally instead of hanging it in
an infinite Workflow Task retry loop, the same way `throw
context.errors.X(...)` does.

An activity no options cover is different. That check runs inside
`declareWorkflow` itself, at module top level, **before** Temporal ever
invokes the workflow function. A throw there is a Workflow Task failure
regardless of the error class — `nonRetryable` has no effect on a failure
that never reaches a `FailWorkflowExecution` command — so it stalls the
workflow via indefinite workflow-task retry rather than failing the
execution. See [Worker surface → Activity
bounds](/reference/worker-surface#activity-bounds) for the full explanation
of why that is deliberate.

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
