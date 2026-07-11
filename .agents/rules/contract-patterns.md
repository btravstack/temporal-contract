# Contract Patterns

## Defining a Contract

Use `defineContract` from `@temporal-contract/contract`:

```typescript
import {
  defineContract,
  defineWorkflow,
  defineActivity,
  defineSignal,
  defineQuery,
  defineUpdate,
  defineSearchAttribute,
} from "@temporal-contract/contract";
import { z } from "zod";

const contract = defineContract({
  taskQueue: "my-task-queue",
  workflows: {
    processOrder: defineWorkflow({
      input: z.object({ orderId: z.string() }),
      output: z.object({ status: z.string() }),
      activities: {
        validateInventory: defineActivity({
          input: z.object({ orderId: z.string() }),
          output: z.object({ available: z.boolean() }),
          // Optional typed domain errors — name becomes ApplicationFailure.type,
          // `data` is schema-validated, `nonRetryable` drives Temporal retries.
          errors: {
            InventoryUnavailable: {
              data: z.object({ missing: z.array(z.string()) }),
              nonRetryable: true,
            },
          },
          // Optional contract-level ActivityOptions defaults. Merge order:
          // declareWorkflow activityOptions < defaultOptions < activityOptionsByName.
          defaultOptions: { startToCloseTimeout: "30 seconds" },
        }),
      },
      signals: {
        cancel: defineSignal({ input: z.object({ reason: z.string() }) }),
      },
      queries: {
        getStatus: defineQuery({
          input: z.object({}),
          output: z.object({ status: z.string() }),
        }),
      },
      updates: {
        addItem: defineUpdate({
          input: z.object({ productId: z.string(), quantity: z.number() }),
          output: z.object({ totalItems: z.number() }),
        }),
      },
      searchAttributes: {
        customerId: defineSearchAttribute({ kind: "KEYWORD" }),
        priority: defineSearchAttribute({ kind: "INT" }),
      },
    }),
  },
  activities: {
    // Global activities shared across workflows
    sendEmail: defineActivity({
      input: z.object({ to: z.string(), subject: z.string() }),
      output: z.object({ sent: z.boolean() }),
    }),
  },
});
```

The `define*` helpers are pass-through identity functions whose only job is to give you better inference at the call site. Inline object literals also work, but the helpers make IDE hover/jump-to-definition more useful.

## Schema Libraries

Any Standard Schema compatible library works:

- **Zod** (most common)
- **Valibot**
- **ArkType**

## Contract Structure

- `taskQueue` — Temporal task queue name
- `workflows` — named workflow definitions with input/output schemas
- `activities` — global activities shared across all workflows
- Each workflow can have:
  - `activities` — workflow-local activity definitions (merged flat with global activities at the worker level)
  - `signals` — async, fire-and-forget messages to a running workflow
  - `queries` — synchronous reads of workflow state (no side effects)
  - `updates` — synchronous request/response with optional validation, can mutate state
  - `searchAttributes` — typed indexed attributes for workflow visibility (kinds: `KEYWORD`, `KEYWORD_LIST`, `TEXT`, `INT`, `DOUBLE`, `BOOL`, `DATETIME`)
  - `errors` — typed domain errors (`{ data?: schema, message?, nonRetryable? }` per name); thrown via `context.errors.X(data)` in the implementation and rehydrated as `ContractError` on the client
- Each activity (global or workflow-local) can additionally declare:
  - `errors` — same shape as workflow errors; produced via the `errors` constructors in the implementation's helpers argument, and rehydrated as a typed `AsyncResult` error union on the workflow side
  - `defaultOptions` — contract-level `ActivityOptions` defaults (timeouts, retry). Merge precedence at the worker: `declareWorkflow` `activityOptions` < `defaultOptions` < `activityOptionsByName`

`defineContract` rejects collisions between workflow-local and global activity names at runtime — `defineContract` runs a Zod validation pass and throws a descriptive error. Activities share a single flat namespace at the worker level, so two activities can't share a name even across workflows. See `packages/contract/src/builder.ts:441` for the validation schema.
