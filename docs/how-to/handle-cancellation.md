# Handle cancellation

Cancellation is a _request_, not a kill. A cancelled workflow keeps running
until it decides to stop, which is what lets it release resources, compensate
for completed steps, and record why it ended.

## Request cancellation from the client

```typescript
const bound = await client.getHandle("processOrder", "order-123");
if (bound.isErr()) {
  throw bound.error;
}

// Cooperative: the workflow observes the request and exits on its own terms.
await bound.value.cancel();

// Forceful: Temporal stops the execution immediately. No cleanup runs.
await bound.value.terminate("fraud detected");
```

Prefer `cancel`. Reach for `terminate` only when the workflow is stuck or
compromised — it runs no compensation logic.

## Observe cancellation in the workflow

Wrap interruptible work in `cancellableScope`. Cancellation arrives as a typed
`Err`, not an exception:

```typescript
import { declareWorkflow } from "@temporal-contract/worker/workflow";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderContract,
  activityOptions: { startToCloseTimeout: "5 minutes" },
  implementation: async (context, order) => {
    const charged = await context.cancellableScope(() =>
      context.activities.chargeCard({ customerId: order.customerId, amount: order.total }),
    );

    if (charged.isErr()) {
      // Cancelled mid-charge — nothing to compensate yet.
      return { status: "cancelled" as const };
    }

    return { status: "completed" as const, transactionId: charged.value.transactionId };
  },
});
```

The `Err` channel of a scope is exactly one type: `WorkflowCancelledError`.
Anything _else_ thrown inside the scope is an unmodeled failure and rides the
defect channel — so a genuine bug is never mistaken for a cancellation.

## Clean up without being interrupted

Once a workflow is cancelled, further activity calls are cancelled too. Cleanup
must run in a `nonCancellableScope`:

```typescript
implementation: async (context, order) => {
  let transactionId: string | undefined;

  const shipped = await context.cancellableScope(async () => {
    const charge = await context.activities.chargeCard({
      customerId: order.customerId,
      amount: order.total,
    });
    transactionId = charge.transactionId;

    return context.activities.createShipment({ orderId: order.orderId });
  });

  if (shipped.isErr()) {
    // Cancelled after the charge but before shipping — refund.
    // Without the non-cancellable scope this refund would itself be cancelled.
    if (transactionId !== undefined) {
      await context.nonCancellableScope(() => context.activities.refundPayment({ transactionId }));
    }
    return { status: "cancelled" as const };
  }

  return {
    status: "completed" as const,
    transactionId: transactionId!,
    trackingNumber: shipped.value.trackingNumber,
  };
};
```

This is the core pattern: **cancellable for the work, non-cancellable for the
compensation.**

## Handle it in an activity

Long-running activities receive cancellation through the Temporal activity
runtime. Heartbeating is what makes an activity cancellable at all:

```typescript
import { Context } from "@temporalio/activity";
import { CancelledFailure } from "@temporalio/common";
import { fromPromise } from "unthrown";

processOrder: {
  exportLedger: ({ accountId }) =>
    fromPromise(
      (async () => {
        for (const page of await ledger.pages(accountId)) {
          // Throws CancelledFailure once cancellation is requested.
          Context.current().heartbeat(page.cursor);
          await store.write(page);
        }
        return { exported: true };
      })(),
      (error) => {
        // Cancellation must propagate — never fold it into a modeled Err.
        if (error instanceof CancelledFailure) {
          throw error;
        }
        return ApplicationFailure.create({
          type: "EXPORT_FAILED",
          cause: error instanceof Error ? error : undefined,
        });
      },
    ),
}
```

For the activity to be cancellable, its options need a `heartbeatTimeout`:

```typescript
activityOptionsByName: {
  exportLedger: {
    startToCloseTimeout: "1 hour",
    heartbeatTimeout: "30 seconds",
  },
}
```

## Do not swallow cancellation

A bare `catch` around an activity call will absorb the cancellation and leave
the workflow running after a cancel request:

```typescript
// ❌ swallows cancellation
try {
  await context.activities.sendNotification({ ... });
} catch (error) {
  log.warn("notification failed, continuing");
}

// ✅ re-throws it
import { isCancellation } from "@temporalio/workflow";

try {
  await context.activities.sendNotification({ ... });
} catch (error) {
  if (isCancellation(error)) {
    throw error;
  }
  log.warn(`notification failed, continuing: ${error}`);
}
```

Any "best effort, keep going" step needs this guard.

## Cancelling child workflows

A child's fate follows `parentClosePolicy`:

```typescript
await context.executeChildWorkflow(orderContract, "collectPayment", {
  workflowId: `payment-${order.orderId}`,
  args: { ... },
  parentClosePolicy: "REQUEST_CANCEL", // default: cancel the child too
});
```

- `REQUEST_CANCEL` — cancel the child when the parent closes (default)
- `TERMINATE` — kill it, no cleanup
- `ABANDON` — let it outlive the parent

A cancelled child surfaces as `Err(ChildWorkflowCancelledError)`.

## Next

- [Run child workflows](/how-to/run-child-workflows)
- [Errors reference](/reference/errors)
- [The result model](/explanation/the-result-model) — why cancellation is an
  `err` and a bug is a `defect`
