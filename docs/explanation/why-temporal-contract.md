# Why temporal-contract

Temporal solves durability. It does not solve the seam between the process that
starts a workflow and the process that runs it — and that seam is where the
bugs live.

## What the raw SDK gives you

A workflow is invoked by **string name** with **positional arguments**:

```typescript
await client.workflow.execute("processOrder", {
  taskQueue: "orders",
  workflowId: "order-123",
  args: [{ orderId: "ORD-1", customerId: "CUST-1", amount: 99.99 }],
});
```

Nothing here is checked. Not the name, not the task queue, not the shape of the
arguments. The SDK's `execute<T>` can be given a type parameter, but that is an
assertion about the other process, not a verified fact — and typically the other
process is a different deployment, on a different release cadence, maintained by
a different team.

The same holds for activities:

```typescript
const { processPayment } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
});
```

`typeof activities` works only while the workflow and the activity
implementations live in one repository and one build. The moment they do not,
the type is a claim nobody verifies.

## What actually goes wrong

**A field is renamed.** The client sends `customerEmail`, the workflow reads
`email`, and gets `undefined`. Nothing throws. The workflow runs to completion
and quietly does the wrong thing. You find out from a support ticket.

**A workflow is renamed.** The string in the client no longer matches anything
on the worker. The workflow is accepted by the server and sits there until it
times out.

**A type drifts.** `amount` arrives as `"99.99"` instead of `99.99` because it
came from a form. Arithmetic silently produces garbage, and it is recorded
durably in history.

**Deployments skew.** The client ships the new argument shape on Tuesday; the
worker ships on Thursday. For two days, every workflow started is malformed —
and durable, so they are still there on Thursday.

Durability is what makes this worse than a normal integration bug. A failed HTTP
request is retried and forgotten. A malformed workflow is _persisted_, retried
according to policy, and may already have charged a card before anyone notices.

## What a contract changes

Declare the shape once:

```typescript
const processOrder = defineWorkflow({
  input: z.object({
    orderId: z.string(),
    customerId: z.string(),
    amount: z.number().positive(),
  }),
  output: z.object({ transactionId: z.string() }),
  activities: { chargeCard },
});

export const orderContract = defineContract({
  taskQueue: "orders",
  workflows: { processOrder },
});
```

Both sides import it, and three things follow.

**Names are checked.** `client.executeWorkflow("processOrder", ...)` only
accepts names on the contract. A typo is a compile error.

**Arguments are typed.** `args` is inferred from the schema. No type parameter to
assert, nothing to keep in sync by hand.

**Data is validated at runtime.** Types vanish at compile time; schemas do not.
A wrong shape is rejected at the boundary with an error naming the field —
_before_ a workflow is started. See [Validation
boundaries](/explanation/validation-boundaries).

The last point is what makes it more than better ergonomics. Types alone cannot
protect a process boundary, because the other side may not be running your
types.

## Fail before, not during

The pivotal difference:

```typescript
const result = await client.executeWorkflow("processOrder", {
  workflowId: "order-1",
  args: { orderId: "ORD-1", customerId: "CUST-1", amount: -1 },
});
// Err(WorkflowValidationError) — no workflow started, no history, no partial state
```

Without the contract, that starts a workflow, records history, charges nothing
or charges wrongly, and leaves a failed execution to explain.

## Failures as values

Temporal's failure model is strings: an `ApplicationFailure` with a `type` that
retry policies match on. Effective for retries, weak for branching. `if
(error.type === "CARD_DECLINED")` is a stringly-typed conditional with a typo
waiting to happen, and no payload beyond a message.

A contract can declare its failures:

```typescript
errors: {
  CardDeclined: {
    data: z.object({ reason: z.enum(["insufficient_funds", "expired"]) }),
    nonRetryable: true,
  },
}
```

The caller gets a typed `ContractError` with validated `data`, and an exhaustive
matcher that stops compiling when the contract grows a new error. Retry
semantics live next to the error's definition rather than scattered across
worker configuration.

That builds on unthrown's three channels — `ok`, `err`, and a separate `defect`
for the genuinely unexpected. See [The result
model](/explanation/the-result-model).

## What it does not do

Being clear about the boundaries:

- **It does not replace the Temporal SDK.** `sleep`, `condition`, `patched`,
  `CancellationScope`, `Context.current()` — you use them directly. This wraps
  the contract-shaped surface, not all of Temporal.
- **It does not enforce determinism.** Nothing stops you writing `Date.now()` in
  a workflow. That is a lint and review concern; see [Workflow
  determinism](/explanation/workflow-determinism).
- **It does not remove the need to understand Temporal.** Timeouts, retry
  policies, task queues, and replay all still matter. It removes the _type_ and
  _validation_ problem, not the distributed systems one.

## When the cost is not worth it

- **One process, one repository, one deploy.** If the workflow and its client
  ship together, `typeof activities` is a real guarantee and the contract adds
  ceremony for a problem you do not have.
- **A prototype.** Schemas are a commitment. Do not make it before the shape has
  settled.
- **You do not want the result discipline.** The library is opinionated:
  activities return `AsyncResult`, and errors are values. If you would rather
  throw, this will feel like friction rather than structure.

## When it pays

- Client and worker deploy separately, at different times.
- More than one team touches the same workflows.
- Inputs come from outside — an API, a queue, a form — where "the types say so"
  is not a guarantee.
- Failures have real consequences, and durability makes a bad execution
  expensive to unwind.

## Next

- [Your first workflow](/tutorial/your-first-workflow)
- [The result model](/explanation/the-result-model)
- [Architecture](/explanation/architecture)
