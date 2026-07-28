# Nexus

::: warning Not implemented
temporal-contract has **no Nexus support**. There is no target release. This
page explains what Nexus is, why a contract layer for it is not trivial, and
what to do in the meantime.
:::

## What Nexus is

[Nexus](https://docs.temporal.io/nexus) lets Temporal applications in isolated
namespaces call each other through defined service boundaries. It exists for the
case that [child workflows](/how-to/run-child-workflows) cannot serve: crossing
a **namespace**, not just a task queue.

```
┌── namespace: orders ──┐        ┌── namespace: payments ──┐
│  processOrder         │──────▶ │  PaymentService         │
│                       │ Nexus  │    .charge()            │
└───────────────────────┘        └─────────────────────────┘
```

Namespaces are Temporal's isolation unit — separate access control, separate
retention, separate quotas. Nexus provides a durable, typed-at-the-service-level
call across that line, so teams can expose capabilities without sharing a
namespace or a deployment.

## Why not just use child workflows?

Cross-contract child workflows already span task queues and worker fleets, and
for most "another team owns this step" cases they are the right tool. They stay
inside one namespace.

Reach for Nexus when the boundary is genuinely organizational: different access
control, different retention policy, different region, or a service you want to
version and evolve independently of its callers.

## Why a contract layer is not straightforward

Nexus is a different shape from what temporal-contract currently models.

**The service is the unit, not the workflow.** A contract today is a task queue
plus its workflows. A Nexus service is an endpoint exposing operations, which
may or may not be backed by workflows — the mapping is not one-to-one.

**Operations have their own lifecycle.** A Nexus operation can be synchronous or
asynchronous, and an async one returns an operation token the caller polls or
awaits. That is a third call shape alongside activities and child workflows,
with its own cancellation and error semantics.

**Errors cross a trust boundary.** Contract errors currently ride
`ApplicationFailure.type` with `details[0]` carrying schema-validated data
between components in one namespace. Across a Nexus boundary the caller may not
be a temporal-contract consumer at all, so the wire format has to be defensible
rather than merely conventional.

**The endpoint is deployment config.** Task queues live on the contract because
they are stable. Nexus endpoints are registry entries that vary per environment
— they do not belong in a contract literal.

None of this is unsolvable, but doing it badly would produce a leaky abstraction
over a feature that is still stabilizing upstream. Waiting is the deliberate
choice.

## Using Nexus today

The raw SDK works alongside temporal-contract. Keep the contract for what it
covers and drop to the SDK at the Nexus boundary:

```typescript
import * as nexus from "@temporalio/nexus";
import { declareWorkflow } from "@temporal-contract/worker/workflow";

const paymentService = nexus.service("PaymentService", {
  charge: nexus.operation<{ customerId: string; amount: number }, { transactionId: string }>(),
});

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, order) => {
    // Contract-typed for everything local...
    const reserved = await context.activities.reserveInventory({ items: order.items });

    // ...raw SDK across the namespace boundary.
    const client = nexus.createNexusClient({
      service: paymentService,
      endpoint: process.env.PAYMENT_NEXUS_ENDPOINT!,
    });
    const charge = await client.executeOperation("charge", {
      customerId: order.customerId,
      amount: order.total,
    });

    return { orderId: order.orderId, transactionId: charge.transactionId };
  },
});
```

The Nexus portion is unvalidated and untyped-by-contract. Two things help:

**Validate at the boundary yourself.** Reuse the schema you would have put on a
contract:

```typescript
const ChargeResult = z.object({ transactionId: z.string() });

const parsed = ChargeResult.safeParse(charge);
if (!parsed.success) {
  throw context.errors.PaymentServiceContractViolation({ issues: parsed.error.message });
}
```

**Wrap it in an activity.** Move the Nexus call into an activity and the
contract covers its input and output again, at the cost of an extra hop:

```typescript
processOrder: {
  chargeViaNexus: ({ customerId, amount }) =>
    fromPromise(nexusClient.executeOperation("charge", { customerId, amount }),
      qualify("NEXUS_CHARGE_FAILED")),
}
```

This is the pragmatic option today — you keep validation and typing at the
contract level, and the Nexus specifics stay in one place.

::: warning Check the SDK
Nexus support in `@temporalio/*` is still evolving and its API has changed
across releases. Treat the snippet above as illustrative and follow the
[official TypeScript Nexus
guide](https://docs.temporal.io/develop/typescript/nexus) for current usage.
:::

## Follow along

- [Temporal Nexus overview](https://docs.temporal.io/nexus)
- [TypeScript Nexus guide](https://docs.temporal.io/develop/typescript/nexus)
- [nexus-hello sample](https://github.com/temporalio/samples-typescript/tree/main/nexus-hello)

Design input is welcome — if you have a concrete Nexus use case that a contract
layer would improve,
[open an issue](https://github.com/btravstack/temporal-contract/issues). Real
use cases are what is missing, not implementation effort.

## Next

- [Run child workflows](/how-to/run-child-workflows) — the in-namespace answer
- [Architecture](/explanation/architecture)
