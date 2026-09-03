---
"@temporal-contract/contract": minor
"@temporal-contract/client": minor
---

Workflows can derive their **workflow ID** from their input:

```ts
const processOrder = defineWorkflow({
  input: OrderSchema,
  output: OrderResultSchema,
  workflowId: ({ orderId }) => `order-${orderId}`,
  startPolicy: "once-per-id",
});
```

`startPolicy` only bites when two starts of the same logical request collide on
one ID, and the ID used to be entirely the caller's — passing
`crypto.randomUUID()` made `"once-per-id"` inert with no diagnostic. A workflow
that declares `workflowId` now derives it from the validated payload on
`startWorkflow` / `executeWorkflow` / `signalWithStart`, and supplying one at
the call site is a type error. Workflows that declare none are unchanged.

`IdempotencyMode` is renamed to `WorkflowStartPolicy` (the old name stays as a
deprecated type alias).
