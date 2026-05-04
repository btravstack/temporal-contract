# Handlers

## Activity Handler

Use `declareActivitiesHandler` with neverthrow's `ResultAsync`:

```typescript
import { declareActivitiesHandler, ApplicationFailure } from "@temporal-contract/worker/activity";
import { ResultAsync } from "neverthrow";

export const activities = declareActivitiesHandler({
  contract: myContract,
  activities: {
    validateInventory: (args) =>
      ResultAsync.fromPromise(inventoryService.check(args.orderId), (error) =>
        ApplicationFailure.create({
          type: "INVENTORY_CHECK_FAILED",
          message: error instanceof Error ? error.message : "Failed to check inventory",
          ...(error instanceof Error ? { cause: error } : {}),
        }),
      ).map((result) => ({ available: result.inStock })),
  },
});
```

## Workflow Declaration

Use `declareWorkflow` for type-safe workflow implementation:

```typescript
import { declareWorkflow } from "@temporal-contract/worker";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, args) => {
    // context.activities — typed, validated activities
    // context.info — WorkflowInfo
    // context.defineSignal/defineQuery/defineUpdate — handler registration
    // context.executeChildWorkflow / context.startChildWorkflow

    const inventory = await context.activities.validateInventory({ orderId: args.orderId });
    return { status: inventory.available ? "confirmed" : "rejected" };
  },
});
```

## Worker Setup

```typescript
import { createWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";

const worker = await createWorker({
  contract: myContract,
  connection,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities,
});

await worker.run();
```

## Anti-patterns

- **Never throw** from activities — use `errAsync(ApplicationFailure.create({ type, message, nonRetryable }))` (or `.mapErr(...)` on a `ResultAsync.fromPromise(...)` chain) instead
- **Never use `any`** — use `unknown` and validate with schemas
- **Always use `.js` extensions** in imports (even for TypeScript files)
