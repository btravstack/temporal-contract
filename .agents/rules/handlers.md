# Handlers

## Activity Handler

Use `declareActivitiesHandler` with unthrown's `AsyncResult`:

```typescript
import { declareActivitiesHandler, ApplicationFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

export const activities = declareActivitiesHandler({
  contract: myContract,
  activities: {
    validateInventory: (args) =>
      fromPromise(inventoryService.check(args.orderId), (error) =>
        ApplicationFailure.create({
          type: "INVENTORY_CHECK_FAILED",
          message: error instanceof Error ? error.message : "Failed to check inventory",
          ...(error instanceof Error ? { cause: error } : {}),
        }),
      ).map((result) => ({ available: result.inStock })),
  },
});
```

`fromPromise(promise, qualify)` forces every rejection through `qualify`, which
returns the modeled error `E` (here an `ApplicationFailure`). For a value you
already have, lift a sync result with `Ok(value).toAsync()` / `Err(failure).toAsync()`
— unthrown has no `okAsync`/`errAsync`.

Canonical example: `examples/order-processing-worker/src/application/activities.ts`.

## Workflow Declaration

Use `declareWorkflow` for type-safe workflow implementation:

```typescript
import { declareWorkflow } from "@temporal-contract/worker/workflow";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, args) => {
    // context.activities — typed, validated activities
    // context.info — WorkflowInfo
    // context.defineSignal/defineQuery/defineUpdate — handler registration
    // context.executeChildWorkflow / context.startChildWorkflow
    // context.cancellableScope / context.nonCancellableScope — see below

    const inventory = await context.activities.validateInventory({ orderId: args.orderId });
    return { status: inventory.available ? "confirmed" : "rejected" };
  },
});
```

Workflow code is deterministic — see [workflow-determinism.md](./workflow-determinism.md) for the banned APIs and replacements.

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

## Cancellation

Workflows opt into cancellation control via `context.cancellableScope` / `context.nonCancellableScope`. They fold cancellation into the project's `AsyncResult` shape — callers branch on `Err(WorkflowCancelledError)` instead of catching `CancelledFailure`.

```typescript
import { isErr } from "unthrown";

implementation: async (context, args) => {
  const result = await context.cancellableScope(async () => {
    return context.activities.processStep(args);
  });

  if (isErr(result)) {
    // Workflow was cancelled. Cleanup that must not be cancelled itself
    // goes inside `nonCancellableScope`.
    await context.nonCancellableScope(async () => {
      await context.activities.releaseResources(args);
    });
    return { status: "cancelled" };
  }

  return { status: "ok" };
};
```

- `cancellableScope<T>(fn)` — returns `AsyncResult<T, WorkflowCancelledError>`. Cancels propagate from outside.
- `nonCancellableScope<T>(fn)` — same shape; _outside_ cancels are ignored. Cancels raised _inside_ still surface as `Err(...)`. Use for graceful-shutdown cleanup.
- Non-cancellation errors thrown by `fn` are _unmodeled_ failures: they ride unthrown's **`defect`** channel (inspectable via `isDefect(result)` / `result.cause`, re-thrown at the edge), not the modeled `err` channel.

Canonical implementation: `packages/worker/src/cancellation.ts:38` (`cancellableScope`), `:75` (`nonCancellableScope`). Error class: `packages/worker/src/errors.ts:193`.

## ApplicationFailure semantics

`ApplicationFailure` (re-exported from `@temporal-contract/worker/activity`) is Temporal's first-class failure type. The wrapper at `packages/worker/src/activity.ts:8-15` rethrows the `Err(...)` payload at the activity boundary, where Temporal recognizes it natively and applies the configured retry policy.

Fields that matter:

| Field          | What it does                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`         | Discriminator. Used by callers (and retry policies via `retry.nonRetryableErrorTypes`) to branch. Required-in-spirit.                      |
| `message`      | Human-readable. Surfaced in Temporal UI.                                                                                                   |
| `nonRetryable` | `true` → Temporal stops retrying this attempt immediately. Use for permanent failures (validation rejection, insufficient funds).          |
| `cause`        | Wraps the underlying `Error`. Always set when wrapping a thrown exception so stack traces survive across the activity → workflow boundary. |
| `details`      | Structured payload (array). Useful for passing context to the workflow without parsing `message`.                                          |

```typescript
ApplicationFailure.create({
  type: "PAYMENT_DECLINED",
  message: "Card declined: insufficient funds",
  nonRetryable: true, // Don't retry — user must change payment method
  details: [{ reason: "insufficient_funds", attemptId: "..." }],
});
```

`WorkflowFailedError` (`packages/client/src/errors.ts`) wraps this on the client side: its `.cause` field is the original `ApplicationFailure` so callers can `instanceof`-check the cause directly.

## Anti-patterns

- **Never throw** from activities — Temporal sees thrown errors as `ApplicationFailure(type: "Error", retryable: true)` by default, which masks the real failure type and triggers unwanted retries. Use `Err(ApplicationFailure.create({ type, message, nonRetryable })).toAsync()` (or a `fromPromise(promise, qualify)` chain whose `qualify` returns the `ApplicationFailure`) instead.
- **Never use `any`** — use `unknown` and validate with schemas. Enforced by oxlint.
- **Always use `.js` extensions** in imports (even for TypeScript files) — required by ESM module resolution.
- **Don't `try/catch` `CancelledFailure` in workflows** — use `cancellableScope` so cancellation flows through the same `AsyncResult` discipline as everything else.
