# Contract Patterns

## Defining a Contract

**Composition-first (org rule, shared with amqp-contract): define resources
individually with the `define*` helpers, then reference them in
`defineContract` — never inline definitions in the contract literal.** Named
resources are reusable across workflows and contracts, get precise
hover/jump-to-definition, and keep the contract a readable table of contents.

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

// Define resources first...
const validateInventory = defineActivity({
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
});

const sendEmail = defineActivity({
  input: z.object({ to: z.string(), subject: z.string() }),
  output: z.object({ sent: z.boolean() }),
});

const processOrder = defineWorkflow({
  input: z.object({ orderId: z.string() }),
  output: z.object({ status: z.string() }),
  activities: { validateInventory },
  signals: {
    cancel: defineSignal({ input: z.object({ reason: z.string() }) }),
  },
  queries: {
    // `input` is optional on signals/queries/updates — omit it for an
    // argument-less definition (handler gets `undefined`).
    getStatus: defineQuery({
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
});

// ...then compose the contract from references.
const contract = defineContract({
  taskQueue: "my-task-queue",
  workflows: { processOrder },
  activities: { sendEmail }, // global activities shared across workflows
});
```

The `define*` helpers are pass-through identity functions whose only job is to give you better inference at the call site.

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

`defineContract` validates the contract's structure at runtime with a hand-rolled structural validator (no zod runtime dependency) and throws a descriptive error: strict root keys (only `taskQueue`/`workflows`/`activities`), identifier-safe names, Standard Schema slots, and collision checks. Activities share a single flat namespace at the worker level, so two _different_ definitions can't share a name even across workflows — but reusing the **same definition object** across workflows is allowed (it's one activity), and the collision message recommends hoisting shared activities to the global `activities` block. A workflow name colliding with a global activity name is also rejected (they share the root of the worker implementations map). See `packages/contract/src/builder.ts` (`validateContractDefinition`).
