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
    const scoped = await context.cancellableScope(async () => {
      // Narrow the activity's own AsyncResult INSIDE the scope's callback.
      // `cancellableScope` is generic over whatever `fn` returns — `T` becomes
      // whatever type `fn` resolves to, verbatim. `AsyncResult` is
      // deliberately NOT a full `PromiseLike` (no `.catch`/`.finally`), so
      // returning `context.activities.chargeCard(...)` un-awaited would make
      // `T` the un-awaited `AsyncResult` itself — a type with no `isOk`/
      // `isErr`/`.value` (those live only on the plain `Result` you get by
      // awaiting). Await it here, and hand the scope a plain, narrowable
      // value instead.
      const charged = await context.activities.chargeCard({
        customerId: order.customerId,
        amount: order.total,
      });
      if (charged.isDefect()) {
        throw charged.cause; // an unmodeled bug — surfaces as the scope's own defect
      }
      if (charged.isErr()) {
        // ActivityError, ActivityCancelledError, or a declared contract error.
        return { ok: false as const, error: charged.error };
      }
      return { ok: true as const, transactionId: charged.value.transactionId };
    });

    // Narrow positively: an `AsyncResult` has three channels (Ok/Err/Defect).
    if (scoped.isDefect()) {
      throw scoped.cause; // a genuine bug thrown inside the scope, not a cancel
    }
    if (scoped.isErr()) {
      // Err(WorkflowCancelledError): the scope itself was cancelled mid-charge
      // — nothing to compensate.
      return { status: "cancelled" as const };
    }

    if (!scoped.value.ok) {
      return handleChargeFailure(scoped.value.error);
    }

    return { status: "completed" as const, transactionId: scoped.value.transactionId };
  },
});
```

The `Err` channel of the scope itself is exactly one type:
`WorkflowCancelledError`, raised when the workflow (or an ancestor scope) is
cancelled while `fn` is in flight. Anything _else_ thrown directly inside the
scope (not returned as a `Result`) is an unmodeled failure and rides the
defect channel — so a genuine bug is never mistaken for a cancellation. The
activity call's _own_ cancellation — the in-flight call itself getting
cancelled — is a separate, independent thing: it surfaces inside `charged`,
folded into the small `{ ok, ... }` envelope the callback returns, not as a
member of `scoped`'s own error union.

### Every activity call carries this hazard

Cancelling an in-flight activity call surfaces as `Err(ActivityCancelledError)`
— one more member of that activity's error union, whether or not the contract
declares any `errors` at all. Generic handling that folds _every_ `Err` to a
fallback value will therefore let the workflow **complete** instead of
cancelling:

```typescript
import { ActivityCancelledError, rethrowCancellation } from "@temporal-contract/worker/workflow";

const charged = await context.activities.chargeCard({ ... });
if (charged.isErr()) {
  if (charged.error instanceof ActivityCancelledError) {
    // Re-raise the cancellation instead of folding it into the fallback path.
    rethrowCancellation(charged.error);
  }
  // Any other failure (ActivityError, or a declared contract error): handle
  // it as usual.
  return handleChargeFailure(charged.error);
}
```

`rethrowCancellation` throws the underlying `CancelledFailure`, so the workflow
ends **Cancelled** the way the operator's `cancel()` intended. It only accepts
a cancellation error (`ActivityCancelledError`,
`ChildWorkflowCancelledError`, or `WorkflowCancelledError`) — narrow to one of
those first, as above, rather than passing the whole error union.

## Clean up without being interrupted

Once a workflow is cancelled, further activity calls are cancelled too. Cleanup
must run in a `nonCancellableScope`:

```typescript
import { propagateActivityFailure } from "@temporal-contract/worker/workflow";

implementation: async (context, order) => {
  let transactionId: string | undefined;

  const shipped = await context.cancellableScope(async () => {
    // Await and narrow the activity's own AsyncResult INSIDE the scope's
    // callback — `propagateActivityFailure` lets a genuine (non-cancellation)
    // charge failure ride the defect channel via the scope's own throw
    // handling, same as it would have without the scope.
    const charge = await propagateActivityFailure(
      context.activities.chargeCard({ customerId: order.customerId, amount: order.total }),
    );
    transactionId = charge.transactionId;

    return propagateActivityFailure(context.activities.createShipment({ orderId: order.orderId }));
  });

  if (shipped.isDefect()) {
    throw shipped.cause; // a genuine bug — or a propagated non-cancellation failure
  }
  if (shipped.isErr()) {
    // Cancelled after the charge but before shipping — refund.
    // Without the non-cancellable scope this refund would itself be cancelled.
    if (transactionId !== undefined) {
      const refunded = await context.nonCancellableScope(() =>
        propagateActivityFailure(context.activities.refundPayment({ transactionId })),
      );
      if (refunded.isDefect()) {
        throw refunded.cause; // a refund that silently failed is worse than a loud failure
      }
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

An activity call never throws — it resolves to an `AsyncResult`, which is a
success-only thenable (see [The result model](/explanation/the-result-model)).
A `try/catch` around one does nothing: there is nothing for the `catch` block
to catch.
Generic handling that folds _every_ `Err` — including `ActivityCancelledError`
— into "log and continue" is what actually absorbs the cancellation and leaves
the workflow running after a cancel request:

```typescript
// ❌ swallows cancellation — ActivityCancelledError falls into the same
// generic branch as an ordinary notification failure
const sent = await context.activities.sendNotification({ ... });
if (sent.isErr()) {
  log.warn("notification failed, continuing");
}

// ✅ re-raises it
import { ActivityCancelledError, rethrowCancellation } from "@temporal-contract/worker/workflow";

const sent = await context.activities.sendNotification({ ... });
if (sent.isErr()) {
  if (sent.error instanceof ActivityCancelledError) {
    rethrowCancellation(sent.error);
  }
  log.warn(`notification failed, continuing: ${sent.error.message}`);
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
