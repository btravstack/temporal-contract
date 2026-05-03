---
"@temporal-contract/worker": minor
---

Add typed cancellation-scope helpers to the workflow context.

Closes #183.

## What ships

Two new methods on the `WorkflowContext` passed to `declareWorkflow`'s `implementation`:

```ts
context.cancellableScope<T>(fn): Future<Result<T, WorkflowCancelledError>>
context.nonCancellableScope<T>(fn): Future<Result<T, WorkflowCancelledError>>
```

Both wrap Temporal's `CancellationScope.cancellable` / `.nonCancellable` so workflows can opt into fine-grained cancellation control without reaching for `@temporalio/workflow` directly. Cancellation surfaces as `Result.Error(WorkflowCancelledError)` instead of a thrown `CancelledFailure`, so call sites can branch on cancellation explicitly. The shape mirrors `context.startChildWorkflow` / `context.executeChildWorkflow`; the rest of the context API (activity proxies, `continueAsNew`) keeps its existing `Promise`-based shape.

```ts
declareWorkflow({
  workflowName: "processOrder",
  contract,
  implementation: async (context, args) => {
    const result = await context.cancellableScope(async () => {
      return context.activities.processStep(args);
    });

    if (result.isError()) {
      // Graceful exit: perform cleanup that must not be cancelled.
      await context.nonCancellableScope(async () => {
        await context.activities.releaseResources(args);
      });
      return { status: "cancelled" };
    }

    return { status: "ok" };
  },
});
```

Non-cancellation errors thrown inside the scope are _not_ swallowed — the Future rejects with the original error, preserving its identity for upstream `try/catch` blocks.

The new `WorkflowCancelledError` class is re-exported from `@temporal-contract/worker/workflow` alongside the existing validation errors.
