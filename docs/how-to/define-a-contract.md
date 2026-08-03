# Define a contract

A contract declares the shape of your Temporal application: which workflows
exist, what they accept and return, which activities they may call, and which
signals, queries, updates, errors, and search attributes they expose.

## Compose, don't inline

Define each resource as its own named value, then reference it from
`defineContract`:

```typescript
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

const chargeCard = defineActivity({
  input: z.object({ customerId: z.string(), amount: z.number().positive() }),
  output: z.object({ transactionId: z.string() }),
});

const processOrder = defineWorkflow({
  input: z.object({ orderId: z.string(), customerId: z.string() }),
  output: z.object({ status: z.enum(["completed", "failed"]) }),
  activities: { chargeCard },
});

export const orderContract = defineContract({
  taskQueue: "orders",
  workflows: { processOrder },
});
```

Inlining everything into `defineContract` works, but named resources are
reusable across workflows and contracts, give you precise hover and
jump-to-definition, and keep the contract itself readable as a table of
contents.

## Scope activities globally or per workflow

Activities declared on the **contract** are reachable from every workflow.
Activities declared on a **workflow** are reachable only from that one.

```typescript
export const orderContract = defineContract({
  taskQueue: "orders",

  // Global: available to every workflow in this contract.
  activities: { sendNotification, writeAuditLog },

  workflows: {
    processOrder, // can call chargeCard + sendNotification + writeAuditLog
    cancelOrder, // can call refundCard + sendNotification + writeAuditLog
  },
});
```

Use global for genuinely cross-cutting effects (notifications, audit logging).
Use workflow-scoped for everything else — it keeps each workflow's reachable
surface small and makes ownership obvious.

::: warning Activity names share one flat namespace
At runtime Temporal resolves activities from a single map, regardless of which
workflow calls them. `defineContract` therefore rejects a duplicate name that
points at two **different** definitions — whether the collision is
workflow-vs-global or between two different workflows:

```
Contract validation failed: workflow "cancelOrder" has activity "chargeCard"
that conflicts with a different same-named activity in workflow
"processOrder". Activities share a single flat namespace at runtime — hoist
the shared activity to the contract's global "activities" block, or rename
one of them.
```

Referencing the **same** `defineActivity` result from several scopes is
allowed — it is one activity, and it flattens unambiguously. On the worker
side you must then implement it with the same function reference (or hoist it
to the global block); `declareActivitiesHandler` rejects two different
implementations for one flat name at declaration time.

If two workflows genuinely need the same operation, declaring it once as a
global activity remains the simplest shape.
:::

## Reuse schemas

Schemas are ordinary values. Extract and share them:

```typescript
const Money = z.object({
  amount: z.number().positive(),
  currency: z.enum(["USD", "EUR", "GBP"]),
});

const Address = z.object({
  street: z.string(),
  city: z.string(),
  postalCode: z.string().regex(/^\d{5}$/),
});

const OrderSchema = z.object({
  orderId: z.string(),
  items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })).min(1),
  total: Money,
  shipTo: Address,
  billTo: Address.optional(),
});
```

Reuse the whole resource, not just its schemas, when the operation is identical:

```typescript
const auditActivities = { writeAuditLog };

export const orderContract = defineContract({
  taskQueue: "orders",
  activities: auditActivities,
  workflows: { processOrder },
});

export const shipmentContract = defineContract({
  taskQueue: "shipments",
  activities: auditActivities,
  workflows: { dispatchShipment },
});
```

## Attach signals, queries, and updates

```typescript
import { defineQuery, defineSignal, defineUpdate } from "@temporal-contract/contract";

const approve = defineSignal({
  input: z.object({ approvedBy: z.string() }),
});

const getStatus = defineQuery({
  output: z.object({ state: z.enum(["pending", "approved", "shipped"]) }),
});

const changeAddress = defineUpdate({
  input: z.object({ address: Address }),
  output: z.object({ address: Address }),
});

const processOrder = defineWorkflow({
  input: OrderSchema,
  output: OrderResultSchema,
  activities: { chargeCard },
  signals: { approve },
  queries: { getStatus },
  updates: { changeAddress },
});
```

Signals have `input` only. Queries and updates have `input` and `output`. On
all three, `input` is optional: omit it for a no-payload signal
(`defineSignal()`) or a no-argument query/update (`defineQuery({ output })`,
`defineUpdate({ output })`) — the handler then receives `undefined`, and the
client-side payload argument becomes omittable.

See [Use signals, queries, and updates](/how-to/use-signals-queries-and-updates)
for handling them.

## Declare domain errors

An `errors` map turns anticipated failures into typed, schema-validated values
instead of opaque strings:

```typescript
const chargeCard = defineActivity({
  input: z.object({ customerId: z.string(), amount: z.number().positive() }),
  output: z.object({ transactionId: z.string() }),
  errors: {
    CardDeclined: {
      data: z.object({ reason: z.string(), retryAfter: z.number().optional() }),
      message: "The card was declined",
      nonRetryable: true,
    },
    GatewayUnavailable: {}, // no payload, retryable
  },
});
```

The error's key becomes the `ApplicationFailure.type` on the wire, `data` is
validated when the error is raised and parsed when it is rehydrated on the
consuming side, and `nonRetryable` drives Temporal's retry policy straight
from the contract.

Workflows declare errors the same way. See
[Model domain errors](/how-to/model-domain-errors).

## Declare search attributes

```typescript
import { defineSearchAttribute } from "@temporal-contract/contract";

const processOrder = defineWorkflow({
  input: OrderSchema,
  output: OrderResultSchema,
  searchAttributes: {
    customerId: defineSearchAttribute({ kind: "KEYWORD" }),
    orderTotal: defineSearchAttribute({ kind: "DOUBLE" }),
    placedAt: defineSearchAttribute({ kind: "DATETIME" }),
  },
});
```

See
[Index workflows with search attributes](/how-to/index-workflows-with-search-attributes).

## Ship activity options with the contract

Operational defaults can live on the contract rather than being repeated in
every worker:

```typescript
const sendNotification = defineActivity({
  input: NotificationSchema,
  output: z.void(),
  activityOptions: {
    startToCloseTimeout: "30 seconds",
    retry: { maximumAttempts: 5 },
  },
});
```

`activityOptions` is a strict object — a typo like `startToCloseTimeOut` fails
at `defineContract` time instead of being silently ignored, and duration
strings are validated against the `ms` grammar (`"30 seconds"`, `"5m"`,
`"1.5h"`), so `"5 minutos"` fails at definition instead of surfacing later as
an opaque worker error. For the full merge order, see
[Tune activity options](/how-to/tune-activity-options).

## Keep contracts focused

One contract maps to one task queue, which maps to one worker deployment. Let
that boundary guide the split:

```typescript
// ✅ A contract per domain, each with its own queue and worker
export const orderContract = defineContract({
  taskQueue: "orders",
  workflows: { processOrder, cancelOrder, refundOrder },
});

export const shipmentContract = defineContract({
  taskQueue: "shipments",
  workflows: { dispatchShipment, trackShipment },
});
```

Workflows in different contracts still call each other — see
[Run child workflows](/how-to/run-child-workflows).

## What `defineContract` checks

It validates at call time and throws on:

- a missing or empty `taskQueue`;
- a contract that declares nothing — at least one workflow **or** one global
  activity is required (`workflows: {}` with global `activities` is valid: an
  activity-only contract models a dedicated activity-pool task queue);
- an unknown top-level key (e.g. a misspelled `workflow`);
- any name that is not a valid JavaScript identifier;
- a name Temporal reserves for its SDK internals — anything starting with
  `__temporal_`, plus the exact query names `__stack_trace` and
  `__enhanced_stack_trace` — **also a `tsc` error** when the name is written
  as a literal in the contract source;
- an `input`, `output`, or error `data` that is not Standard Schema compatible;
- duplicate activity names across the flat namespace that point at
  **different** definitions (sharing one `defineActivity` result is allowed)
  — **also a `tsc` error** when the two definitions are structurally
  distinguishable;
- unknown keys or malformed duration strings in `activityOptions` — a
  malformed literal duration like `"5 minutos"` is **also a `tsc` error**; a
  duration built from a computed `string` (read from config, etc.) has no
  literal to inspect, so only the runtime check catches it.

```
Contract validation failed: taskQueue cannot be empty
```

Because this runs at import time, a malformed contract fails when the process
starts rather than when a workflow first executes. The three checks called
out above also run at `tsc` time, ahead of import, for whatever a literal in
the contract source lets the type checker prove — the runtime check still
runs unconditionally and remains authoritative.

## Next

- [Implement activities](/how-to/implement-activities)
- [Contract surface](/reference/contract-surface) — every option, exhaustively
- [Validation boundaries](/explanation/validation-boundaries) — where and why
  schemas run
