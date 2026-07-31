# Handle cancellation

Cancellation is a _request_, not a kill. A cancelled workflow keeps running
until it decides to stop, which is what lets it release resources, compensate
for completed steps, and record why it ended.

## Request cancellation from the client

```typescript
const bound = client.getHandle("processOrder", "order-123"); // synchronous Result
if (!bound.isOk()) {
  // Narrow positively: after ruling out Ok, the value is Err or Defect, so
  // reading `bound.value` would not compile — a defect rides `bound.cause`.
  throw bound.isErr() ? bound.error : bound.cause;
}

// Cooperative: the workflow observes the request and exits on its own terms.
// `.getOrThrow()` surfaces a WorkflowExecutionNotFoundError — a bare `await`
// would collapse the AsyncResult to an ignored Result instead.
await bound.value.cancel().getOrThrow();

// Forceful: Temporal stops the execution immediately. No cleanup runs.
await bound.value.terminate("fraud detected").getOrThrow();
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

    // Narrow positively: an `AsyncResult` has three channels (Ok/Err/Defect),
    // so `charged.value` only compiles after `isOk()`.
    if (charged.isOk()) {
      return { status: "completed" as const, transactionId: charged.value.transactionId };
    }
    if (charged.isDefect()) {
      throw charged.cause; // a genuine bug thrown inside the scope, not a cancel
    }

    // Err(WorkflowCancelledError): cancelled mid-charge — nothing to compensate.
    return { status: "cancelled" as const };
  },
});
```

The `Err` channel of a scope is exactly one type: `WorkflowCancelledError`.
Anything _else_ thrown inside the scope is an unmodeled failure and rides the
defect channel — so a genuine bug is never mistaken for a cancellation.

### Activities that declare their own errors

When an activity declares an `errors` map, cancelling it no longer throws
through — it surfaces as `Err(ActivityCancelledError)`, one more member of that
activity's error union. Generic handling that folds _every_ `Err` to a fallback
value will therefore let the workflow **complete** instead of cancelling:

```typescript
import { rethrowCancellation } from "@temporal-contract/worker/workflow";

const charged = await context.activities.chargeCard({ ... });
if (!charged.isOk()) {
  if (charged.isDefect()) throw charged.cause;
  // Re-raise a cancellation instead of swallowing it into the fallback path.
  // For any other declared error, handle it as usual below.
  rethrowCancellation(charged.error);
  return handleChargeFailure(charged.error);
}
```

`rethrowCancellation` throws the underlying `CancelledFailure` when the error is
a cancellation and is a no-op otherwise, so the workflow ends **Cancelled** the
way the operator's `cancel()` intended.

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
      // Unwrap: a refund that silently failed is worse than a loud failure,
      // and a bare `await` would discard both the Err and any defect.
      await context
        .nonCancellableScope(() => context.activities.refundPayment({ transactionId }))
        .getOrThrow();
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
import { ApplicationFailure } from "@temporalio/common";
import { Context } from "@temporalio/activity";
import { CancelledFailure } from "@temporalio/common";
import { fromPromise } from "unthrown";

processOrder: {
  exportLedger: ({ accountId }) =>
    fromPromise(
      (async () => {
        const { cancellationSignal } = Context.current();
        for (const page of await ledger.pages(accountId)) {
          // heartbeat() reports liveness (and is what arms the heartbeatTimeout
          // and cancellation); it returns void and never throws. Observe the
          // request through the abort signal — or let a cancellation-aware call
          // (Context.current().sleep(), a signal-wired fetch) throw for you.
          Context.current().heartbeat(page.cursor);
          if (cancellationSignal.aborted) {
            throw new CancelledFailure("export cancelled");
          }
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
  parentClosePolicy: "REQUEST_CANCEL", // opt in; Temporal's default is TERMINATE
});
```

- `TERMINATE` — kill the child when the parent closes, no cleanup (Temporal's default)
- `REQUEST_CANCEL` — cancel the child so it can compensate and exit on its own terms
- `ABANDON` — let it outlive the parent

A cancelled child surfaces as `Err(ChildWorkflowCancelledError)`.

## Next

- [Run child workflows](/how-to/run-child-workflows)
- [Errors reference](/reference/errors)
- [The result model](/explanation/the-result-model) — why cancellation is an
  `err` and a bug is a `defect`
