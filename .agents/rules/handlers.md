# Handlers

## Activity Handler

Use `declareActivitiesHandler` with Result/Future pattern:

```typescript
import { declareActivitiesHandler, ApplicationFailure } from "@temporal-contract/worker/activity";
import { Future, Result } from "@swan-io/boxed";

export const activities = declareActivitiesHandler({
  contract: myContract,
  activities: {
    validateInventory: (args) => {
      return Future.make(async (resolve) => {
        try {
          const result = await inventoryService.check(args.orderId);
          resolve(Result.Ok({ available: result.inStock }));
        } catch (error) {
          resolve(
            Result.Error(
              ApplicationFailure.create({
                type: "INVENTORY_CHECK_FAILED",
                message: error instanceof Error ? error.message : "Failed to check inventory",
                ...(error instanceof Error ? { cause: error } : {}),
              }),
            ),
          );
        }
      });
    },
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

- **Never throw** from activities — use `Result.Error(ApplicationFailure.create({ type, message, nonRetryable }))` instead
- **Never use `any`** — use `unknown` and validate with schemas
- **Always use `.js` extensions** in imports (even for TypeScript files)
