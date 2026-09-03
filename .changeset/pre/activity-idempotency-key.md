---
"@temporal-contract/contract": minor
"@temporal-contract/worker": minor
"@temporal-contract/testing": minor
---

Activities can declare an **idempotency key**, derived from their input:

```ts
const chargeCard = defineActivity({
  input: z.object({ orderId: z.string(), customerId: z.string(), amount: z.number() }),
  output: PaymentSchema,
  // Key on what IDENTIFIES the charge, not on what describes it: one customer
  // placing two orders of the same value must not collide on one key.
  idempotencyKey: ({ orderId }) => `charge:${orderId}`,
});

chargeCard: ({ input, idempotencyKey }) =>
  fromPromise(
    gateway.charge(input, { idempotencyKey }),
    qualifyFailure("CHARGE_FAILED", { expected: GatewayError }),
  ),
```

Temporal runs activities **at least once**, and nothing in the library helped
with that until now — `idempotency` on a workflow is start deduplication and
says nothing about an activity running twice. Being payload-derived, the key is
stable across activity retries, worker crashes, and a fresh workflow execution
with the same input.

`helpers.idempotencyKey` is typed `string` for an activity that declares one and
`undefined` for one that does not, so reaching for a key that was never declared
is a compile error. `runActivity` hands over the same value.

Good key sources: a business identifier already in the input, a dedicated
`idempotencyKey` field the caller mints, or the workflow ID — which is
per-execution and, when the contract derives it, a function of the payload.
