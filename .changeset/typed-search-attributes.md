---
"@temporal-contract/contract": minor
"@temporal-contract/client": minor
"@temporal-contract/worker": minor
"@temporal-contract/boxed": minor
"@temporal-contract/testing": minor
---

Add typed search attributes to the contract surface.

Closes #180.

## What ships

**Contract** — declare attribute kinds alongside signals/queries/updates:

```ts
import { defineContract, defineSearchAttribute, defineWorkflow } from "@temporal-contract/contract";

defineContract({
  taskQueue: "orders",
  workflows: {
    processOrder: defineWorkflow({
      input: z.object({ orderId: z.string() }),
      output: z.object({ status: z.string() }),
      searchAttributes: {
        customerId: defineSearchAttribute({ kind: "KEYWORD" }),
        priority: defineSearchAttribute({ kind: "INT" }),
        placedAt: defineSearchAttribute({ kind: "DATETIME" }),
        tags: defineSearchAttribute({ kind: "KEYWORD_LIST" }),
        urgent: defineSearchAttribute({ kind: "BOOL" }),
      },
    }),
  },
});
```

The seven Temporal kinds (`TEXT`, `KEYWORD`, `INT`, `DOUBLE`, `BOOL`, `DATETIME`, `KEYWORD_LIST`) map to TypeScript types via the new `SearchAttributeKindToType<K>` utility.

**Client** — `searchAttributes` becomes a typed parameter on `startWorkflow` and `executeWorkflow`. Keys are constrained to declared attributes, value types follow each attribute's `kind`:

```ts
await client.startWorkflow("processOrder", {
  workflowId: "order-1",
  args: { orderId: "ORD-1" },
  searchAttributes: {
    customerId: "CUST-1", // string (KEYWORD)
    priority: 3, // number (INT)
    placedAt: new Date(), // Date (DATETIME)
    tags: ["vip", "urgent"], // string[] (KEYWORD_LIST)
    urgent: true, // boolean (BOOL)
  },
});
```

The client translates the typed map into a Temporal `TypedSearchAttributes` instance before dispatching the start request.

**Validation** — `defineContract` validates that each search-attribute name is a JS identifier and that each `kind` is one of the seven supported values.

## New peer dep

`@temporal-contract/client` adds `@temporalio/common` as a peer dependency (alongside the existing `@temporalio/client` peer) for the `TypedSearchAttributes` import.

## Deferred

The worker-side typed reader (`context.searchAttributes.get("customerId")`) is not in this PR. Workers can still read via Temporal's `workflowInfo().typedSearchAttributes`, and the contract-declared attribute kinds make it straightforward to wrap that in a typed accessor in a follow-up.
