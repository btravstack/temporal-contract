# Index workflows with search attributes

Search attributes are indexed fields on Temporal's visibility store. They let
you find executions by domain criteria — "every pending order for customer X",
"all high-priority jobs started this week" — instead of only by workflow id.

Declaring them on the contract constrains both the keys and their value types.

## Declare them

```typescript
import { defineSearchAttribute, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

export const processOrder = defineWorkflow({
  input: OrderSchema,
  output: OrderResultSchema,
  // Search attributes are this doc's topic, but `startPolicy` is required on
  // every workflow. `retry-if-failed` is the right mode for this shape — an
  // order that charged a customer must not be re-runnable after a Completed
  // run. See "Declare idempotency" in define-a-contract.md.
  startPolicy: "retry-if-failed",
  searchAttributes: {
    customerId: defineSearchAttribute({ kind: "KEYWORD" }),
    orderTotal: defineSearchAttribute({ kind: "DOUBLE" }),
    priority: defineSearchAttribute({ kind: "INT" }),
    placedAt: defineSearchAttribute({ kind: "DATETIME" }),
    tags: defineSearchAttribute({ kind: "KEYWORD_LIST" }),
    expedited: defineSearchAttribute({ kind: "BOOL" }),
    notes: defineSearchAttribute({ kind: "TEXT" }),
  },
});
```

The seven kinds map to TypeScript like this:

| `kind`         | TypeScript type | Notes                                           |
| -------------- | --------------- | ----------------------------------------------- |
| `TEXT`         | `string`        | Tokenized; full-text search, not exact match    |
| `KEYWORD`      | `string`        | Exact match. The right choice for ids and enums |
| `INT`          | `number`        | 64-bit integer                                  |
| `DOUBLE`       | `number`        | Floating point                                  |
| `BOOL`         | `boolean`       |                                                 |
| `DATETIME`     | `Date`          |                                                 |
| `KEYWORD_LIST` | `string[]`      | Exact match against any element                 |

::: warning `TEXT` vs `KEYWORD`
`TEXT` is analyzed and tokenized — searching it does substring/word matching,
and it cannot be used in `ORDER BY`. `KEYWORD` is stored verbatim and matches
exactly. For an id, status, or enum you almost always want `KEYWORD`.
:::

## Register them on the server

Declaring an attribute on the contract does not create it on the cluster.
Register it once per namespace before use:

```bash
temporal operator search-attribute create \
  --name customerId --type Keyword \
  --namespace default

temporal operator search-attribute create --name orderTotal --type Double
temporal operator search-attribute create --name priority   --type Int
temporal operator search-attribute create --name placedAt   --type Datetime
temporal operator search-attribute create --name tags       --type KeywordList
temporal operator search-attribute create --name expedited  --type Bool
temporal operator search-attribute create --name notes      --type Text
```

On Temporal Cloud, use the UI or `tcld`. Starting a workflow with an
unregistered attribute fails.

## Set them when starting a workflow

```typescript
const result = await client.executeWorkflow("processOrder", {
  workflowId: "order-123",
  args: order,
  searchAttributes: {
    customerId: "CUST-456",
    orderTotal: 249.99,
    priority: 1,
    placedAt: new Date(),
    tags: ["expedited", "gift"],
    expedited: true,
  },
});
```

Keys and value types are checked against the contract. An undeclared key, or a
`Date` where the contract says `KEYWORD`, is a compile error. Every attribute
is optional — set only the ones you have.

The same option works on `startWorkflow`, `signalWithStart`, and
`schedule.create`.

## Read them back

`readTypedSearchAttributes` turns Temporal's untyped `TypedSearchAttributes`
instance into a typed partial object:

```typescript
import { readTypedSearchAttributes } from "@temporal-contract/client";

const bound = client.getHandle("processOrder", "order-123"); // synchronous Result
if (!bound.isOk()) {
  // After ruling out Ok the value is Err or Defect, so `bound.value` would not
  // compile — narrow positively and rethrow either channel.
  throw bound.isErr() ? bound.error : bound.cause;
}

const described = await bound.value.describe();
if (described.isOk()) {
  const attrs = readTypedSearchAttributes(
    orderContract.workflows.processOrder,
    described.value.typedSearchAttributes,
  );

  attrs.customerId; // string | undefined
  attrs.orderTotal; // number | undefined
  attrs.placedAt; // Date | undefined
}
```

Every field is optional — an attribute that was never set is `undefined`.

## Query executions

Search attributes are queried with Temporal's list filter syntax, through the
underlying SDK client:

```typescript
const temporalClient = new Client({ connection });

for await (const execution of temporalClient.workflow.list({
  query: `WorkflowType = 'processOrder' AND customerId = 'CUST-456' AND ExecutionStatus = 'Running'`,
})) {
  console.log(execution.workflowId, execution.status.name);
}
```

More examples:

```sql
-- High-value orders placed today
orderTotal > 1000 AND placedAt > '2026-07-28T00:00:00Z'

-- Any expedited or gift order
tags IN ('expedited', 'gift')

-- Most recent first
WorkflowType = 'processOrder' ORDER BY placedAt DESC
```

## Schedule-spawned runs

Attributes set on a schedule apply to each run it spawns, so scheduled and
directly started executions are indexed identically:

```typescript
await client.schedule
  .create("processOrder", {
    scheduleId: "nightly-reconcile",
    spec: { cronExpressions: ["0 2 * * *"] },
    args: { mode: "reconcile" },
    searchAttributes: {
      priority: 5,
      tags: ["scheduled"],
    },
  })
  .getOrThrow();
```

## Keep the cardinality sane

Visibility indexes are not a general-purpose database:

- **Do** index fields you filter or sort operational queries by.
- **Don't** index free-form user content, large payloads, or anything with
  near-unique values per execution beyond the ids you actually search on.
- **Don't** treat them as workflow state. They are metadata for finding
  executions; the workflow's own state belongs in its input and in
  [queries](/how-to/use-signals-queries-and-updates).

## Next

- [Schedule workflows](/how-to/schedule-workflows)
- [Client surface](/reference/client-surface)
- [Contract surface](/reference/contract-surface)
