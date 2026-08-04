# Model domain errors

By default a failed activity or workflow surfaces to its caller as a generic
`ApplicationFailure` with a string `type` and a message. That is fine for
technical faults, but poor for _domain_ failures the caller is expected to
branch on — "card declined", "out of stock", "quota exceeded".

Declaring those on the contract makes them typed values with validated payloads
on both sides of the wire.

## Declare the errors

Add an `errors` map to the activity or workflow:

```typescript
const chargeCard = defineActivity({
  input: z.object({ customerId: z.string(), amount: z.number().positive() }),
  output: z.object({ transactionId: z.string() }),
  errors: {
    CardDeclined: {
      data: z.object({
        reason: z.enum(["insufficient_funds", "expired", "fraud_suspected"]),
        retryAfter: z.number().optional(),
      }),
      message: "The card was declined",
      nonRetryable: true,
    },
    GatewayUnavailable: {}, // no payload, retryable
  },
});
```

Each entry:

| Field          | Meaning                                                                |
| -------------- | ---------------------------------------------------------------------- |
| key            | Becomes the `ApplicationFailure.type` on the wire                      |
| `data`         | Standard Schema for the payload. Optional — omit for a data-less error |
| `message`      | Default human-readable message                                         |
| `nonRetryable` | `true` stops Temporal retrying. Default `false`                        |

Because `nonRetryable` lives on the contract, retry semantics ship with the
contract instead of being scattered across worker configuration.

## Raise one from an activity

Implementations receive typed constructors as `errors` in the second argument:

```typescript
import { declareActivitiesHandler, qualifyFailure } from "@temporal-contract/worker/activity";
import { Err, fromPromise, Ok } from "unthrown";

export const activities = declareActivitiesHandler({
  contract: orderContract,
  activities: {
    processOrder: {
      chargeCard: ({ customerId, amount }, { errors }) =>
        fromPromise(
          gateway.charge(customerId, amount),
          // `expected` is required: name the anticipated failure class (or a
          // predicate). Anything else rides the defect channel.
          qualifyFailure("CHARGE_FAILED", { expected: GatewayError }),
        ).flatMap((charge) =>
          charge.declined
            ? // Typed on the caller's side; `nonRetryable` comes from the contract.
              Err(errors.CardDeclined({ reason: charge.declineCode, retryAfter: 3600 }))
            : Ok({ transactionId: charge.id }),
        ),
    },
  },
});
```

The constructor's argument is typed from the `data` schema. A data-less error
takes no payload:

```typescript
Err(errors.GatewayUnavailable());
Err(errors.GatewayUnavailable({ message: "circuit breaker open" })); // override the message
```

## Raise one from a workflow

Workflows declare errors the same way and get constructors on `context.errors`.
Workflow errors are **thrown**, not returned:

```typescript
const processOrder = defineWorkflow({
  input: OrderSchema,
  output: OrderResultSchema,
  idempotency: "retry-if-failed", // charges a card
  errors: {
    EmptyOrder: {
      data: z.object({ orderId: z.string() }),
      nonRetryable: true,
    },
  },
  activities: { chargeCard },
});
```

```typescript
export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderContract,
  activityOptions: { startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3 } },
  implementation: async (context, order) => {
    if (order.items.length === 0) {
      throw context.errors.EmptyOrder({ orderId: order.orderId });
    }
    // ...
  },
});
```

::: tip Why thrown and not returned?
A workflow's return value _is_ its output, and it must match the output schema.
Throwing a contract error is how a workflow fails deliberately. The wrapper
converts it to an `ApplicationFailure` before it leaves the workflow — which
matters, because a plain `Error` thrown from workflow code is treated by
Temporal as a _task_ failure and retried forever, whereas an
`ApplicationFailure` fails the execution terminally.
:::

## Consume one in a workflow

Every activity call returns an `AsyncResult<Output, ActivityError |
ActivityCancelledError>` — declaring an `errors` map doesn't change that shape,
it folds the declared, rehydrated errors into the same channel:

| The activity declares | The workflow call's error channel                               |
| --------------------- | --------------------------------------------------------------- |
| no `errors` map       | `ActivityError \| ActivityCancelledError`                       |
| an `errors` map       | `ContractErrorUnion \| ActivityError \| ActivityCancelledError` |

So every activity is awaited as a result, not a plain value:

```typescript
import { CONTRACT_ERROR_TAG } from "@temporal-contract/contract";
import { P } from "unthrown";

implementation: async (context, order) => {
  const charged = await context.activities.chargeCard({
    customerId: order.customerId,
    amount: order.total,
  });

  return charged.match({
    ok: (payment) => ({ status: "completed" as const, transactionId: payment.transactionId }),
    errCases: (matcher) =>
      matcher
        // Object-pattern: every ContractError shares one `_tag`, so a specific
        // declared error is discriminated on `errorName`. `error.data` then
        // narrows to that error's schema.
        .with({ errorName: "CardDeclined" }, (error) => ({
          status: "failed" as const,
          reason: error.data.reason,
        }))
        // Any other declared error on this activity (here: GatewayUnavailable).
        .with(P.tag(CONTRACT_ERROR_TAG), (error) => ({
          status: "failed" as const,
          reason: error.errorName,
        }))
        .with(
          P.tag("@temporal-contract/ActivityError"),
          P.tag("@temporal-contract/ActivityCancelledError"),
          (error) => ({ status: "failed" as const, reason: error.message }),
        ),
    defect: (cause) => ({
      status: "failed" as const,
      reason: cause instanceof Error ? cause.message : "unexpected failure",
    }),
  });
};
```

`ActivityError` covers everything that is _not_ a declared error — retries
exhausted, a timeout, an undeclared `ApplicationFailure` type. Its `cause` is
the unwrapped actionable failure, with Temporal's `ActivityFailure` wrapper
already seen through.

::: tip This is a deliberate trade
Every activity call is already a `Result` — declaring errors doesn't add a
result fold, it adds typed members to the one you already have. Declare errors
on the activities whose failures the workflow actually branches on; for the
rest, `propagateActivityFailure` keeps the call site to a single line instead
of a fold. See [The result model](/explanation/the-result-model).
:::

## Consume one on the client

A workflow whose declared error caused the failure surfaces it as a
`ContractError` on the result's `err` channel, instead of the generic
`WorkflowFailedError`:

```typescript
import { CONTRACT_ERROR_TAG } from "@temporal-contract/contract";
import { P } from "unthrown";

const result = await client.executeWorkflow("processOrder", {
  workflowId: "order-1",
  args: order,
});

result.match({
  ok: (output) => console.log("done:", output),
  errCases: (matcher) =>
    matcher
      .with(P.tag(CONTRACT_ERROR_TAG), (error) => {
        switch (error.errorName) {
          case "EmptyOrder":
            return console.error("no items on order", error.data.orderId);
          default:
            return console.error("contract error:", error.errorName);
        }
      })
      .with(
        P.tag("@temporal-contract/WorkflowNotInContractError"),
        P.tag("@temporal-contract/WorkflowValidationError"),
        P.tag("@temporal-contract/WorkflowAlreadyStartedError"),
        P.tag("@temporal-contract/WorkflowFailedError"),
        P.tag("@temporal-contract/WorkflowExecutionNotFoundError"),
        (error) => console.error("failed:", error.message),
      ),
  defect: (cause) => console.error("unexpected:", cause),
});
```

Two levels of discrimination are at work:

- the unthrown `_tag` — the exported `CONTRACT_ERROR_TAG` constant, whose value
  is `"@temporal-contract/ContractError"` — separates a contract error from the
  client's other error classes. Prefer the constant to a hand-typed string: it
  is greppable and immune to typos. It is exported from the package root and
  from `@temporal-contract/contract/errors`;
- `errorName` then narrows to the specific declared error, with `data` typed
  accordingly. Because every declared error shares that one `_tag`, matching a
  single error by tag alone is impossible — discriminate on `errorName`,
  either with a `switch` or an object pattern (`.with({ errorName: "EmptyOrder" }, ...)`).

## What travels on the wire

```
Err(errors.CardDeclined({ reason: "expired" }))
   │
   ├─ data validated against the declared schema
   ▼
ApplicationFailure {
  type: "CardDeclined",          // the declared key
  message: "The card was declined",
  nonRetryable: true,            // from the contract
  details: [
    { reason: "expired" },       // details[0] — the original payload
    { $tc: 1 },                  // details[1] — the wire marker
  ],
}
   │
   ▼
ContractError { errorName: "CardDeclined", data: { reason: "expired" } }
```

`details[1]` carries a small envelope marker (`{ $tc: 1 }`) that tags the
failure as a rehydratable contract error. It governs rehydration:

- for an error **with** a `data` schema, schema validation of `details[0]` is
  the gate — the marker is corroborating but not required;
- for a **data-less** error, the marker is **required**. Without it, any
  unrelated `ApplicationFailure` whose `type` happens to equal a declared
  data-less error name would be mis-surfaced as the typed domain error.

The payload is validated when it is raised _and_ re-validated when it is
rehydrated, so a schema change that breaks compatibility surfaces as a clear
validation error rather than a silently wrong object. When a failure does not
correspond to a declared error — unknown `type`, a payload that no longer
validates, or a data-less name without the marker — rehydration degrades to
the generic failure classification instead of producing a wrong typed error,
and reports the miss through the `onRehydrationMiss` diagnostic hook.

## Failure modes

**Raising an undeclared error** — a name not in the contract's `errors` map
throws `ContractErrorDataValidationError`:

```
Error "CardExpired" is not declared on activity "processOrder.chargeCard".
Declared errors: CardDeclined, GatewayUnavailable.
```

The activity is named by its flat label — a workflow-scoped activity appears as
`workflowName.activityName` (here `processOrder.chargeCard`), a global activity
as its bare name.

**Payload fails its schema** — same terminal error, with the schema issues
attached. Both are deterministic contract-misuse bugs, so they fail loudly
rather than letting a malformed failure cross the wire.

## When not to use this

Declared errors are for failures the _caller_ branches on. For technical faults
— a timeout, a connection reset, a bug — use `qualifyFailure` and a plain
`ApplicationFailure`. Retries handle those, and the caller has no meaningful
decision to make.

## Next

- [Errors reference](/reference/errors) — every error class and its tag
- [The result model](/explanation/the-result-model) — err vs defect
- [Tune activity options](/how-to/tune-activity-options) — retry policy
  interaction
