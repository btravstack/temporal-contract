# Run child workflows

A child workflow is a workflow started by another workflow. Use one when a
sub-process deserves its own execution history, its own retry and timeout
policy, or its own task queue and worker fleet.

Both entry points take the child's **contract** as the first argument, so
same-contract and cross-contract calls look identical.

## Execute and wait

`executeChildWorkflow` starts the child and waits for its result:

```typescript
import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { P } from "unthrown";

import { orderContract } from "./contract.js";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, order) => {
    const payment = await context.executeChildWorkflow(orderContract, "collectPayment", {
      workflowId: `payment-${order.orderId}`,
      args: { customerId: order.customerId, amount: order.total },
    });

    return payment.match({
      ok: (output) => ({ status: "completed" as const, transactionId: output.transactionId }),
      errCases: (matcher) =>
        matcher.with(
          P.tag("@temporal-contract/ChildWorkflowError"),
          P.tag("@temporal-contract/ChildWorkflowCancelledError"),
          P.tag("@temporal-contract/ChildWorkflowNotFoundError"),
          (error) => ({ status: "failed" as const, reason: error.message }),
        ),
      defect: (cause) => ({
        status: "failed" as const,
        reason: cause instanceof Error ? cause.message : "unexpected failure",
      }),
    });
  },
});
```

**Child workflows return a `Result`; activities do not.** That asymmetry is
deliberate — a child workflow is a peer operation whose failure is usually a
branch in your logic, whereas an activity failure is normally something
Temporal's retry policy should handle. See
[The result model](/explanation/the-result-model).

## Start without waiting

`startChildWorkflow` returns a handle as soon as the child starts, letting the
parent continue and collect the result later:

```typescript
implementation: async (context, order) => {
  const started = await context.startChildWorkflow(orderContract, "sendReceipt", {
    workflowId: `receipt-${order.orderId}`,
    args: { customerId: order.customerId },
  });

  if (started.isErr()) {
    return { status: "failed", reason: started.error.message };
  }

  // Do other work while the child runs.
  const shipment = await context.activities.createShipment({ orderId: order.orderId });

  // Then collect.
  const receipt = await started.value.result();

  return {
    status: "completed",
    trackingNumber: shipment.trackingNumber,
    receiptSent: receipt.isOk(),
  };
};
```

The handle exposes `workflowId`, `firstExecutionRunId` (the anchor of the
child's execution chain, stable across continue-as-new), a typed `signals`
map, and `result()`.

## Signal a running child

The handle's `signals` map mirrors the client handle's — one sender per
signal the child's contract entry declares, fully typed:

```typescript
implementation: async (context, order) => {
  const started = await context.startChildWorkflow(orderContract, "collectPayment", {
    workflowId: `payment-${order.orderId}`,
    args: { customerId: order.customerId, amount: order.total },
  });

  if (started.isErr()) {
    return { status: "failed", reason: started.error.message };
  }

  // Typed: the payload is checked against the child's signal schema.
  const signaled = await started.value.signals.applyDiscount({ percent: 10 });
  if (signaled.isErr()) {
    // ChildWorkflowError (incl. a payload failing validation before send)
    // or ChildWorkflowCancelledError.
  }

  const payment = await started.value.result();
  return { status: payment.isOk() ? "completed" : "failed" };
};
```

The payload is validated before sending and parsed by the child on receive.
Unlike a _client_ handle — where a payload-less signal's argument is omittable
— a child handle's signal sender always takes an explicit argument, so pass
`undefined` for a payload-less signal (`applyDiscount(undefined)`).

## Run children in parallel

Start them all, then await:

```typescript
implementation: async (context, order) => {
  const started = await Promise.all(
    order.items.map((item) =>
      context.startChildWorkflow(orderContract, "fulfilItem", {
        workflowId: `fulfil-${order.orderId}-${item.sku}`,
        args: { sku: item.sku, quantity: item.quantity },
      }),
    ),
  );

  const handles = started.filter((s) => s.isOk()).map((s) => s.value);
  const results = await Promise.all(handles.map((h) => h.result()));

  return {
    fulfilled: results.filter((r) => r.isOk()).length,
    failed: results.filter((r) => r.isErr()).length,
  };
};
```

`Promise.all` is safe in workflow code — Temporal's deterministic scheduler
handles it. What is _not_ safe is anything that reads real-world state; see
[Workflow determinism](/explanation/workflow-determinism).

## Call across contracts

Pass the other contract. Its task queue and workflow type come along, so the
child runs on whichever worker fleet serves it:

```typescript
import { notificationContract } from "@acme/notification-contract";

implementation: async (context, order) => {
  const notified = await context.executeChildWorkflow(
    notificationContract,
    "sendOrderConfirmation",
    {
      workflowId: `notify-${order.orderId}`,
      args: { orderId: order.orderId, customerId: order.customerId },
    },
  );

  return { status: notified.isOk() ? "completed" : "partial" };
};
```

Both sides stay fully typed: the child's `args` are checked against _its_
contract, and its output type flows back. Publish contracts as their own
packages and this works across teams.

## Control the child's lifecycle

`TypedChildWorkflowOptions` is Temporal's `ChildWorkflowOptions` minus
`taskQueue` and `args` (which come from the contract), plus the typed `args`:

```typescript
await context.executeChildWorkflow(orderContract, "collectPayment", {
  workflowId: `payment-${order.orderId}`,
  args: { customerId: order.customerId, amount: order.total },

  // What happens to the child if the parent closes (Temporal's default is TERMINATE).
  parentClosePolicy: "REQUEST_CANCEL", // or "TERMINATE" | "ABANDON"

  workflowExecutionTimeout: "1 hour",
  workflowRunTimeout: "10 minutes",
  retry: { maximumAttempts: 3 },

  // Reuse behaviour when the id already exists.
  workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
});
```

`parentClosePolicy` is the one to think about: the default (`TERMINATE`) kills
children when the parent closes. Choose `REQUEST_CANCEL` if a child needs to
compensate first, or `ABANDON` for fire-and-forget work that should outlive its
parent.

## Choose child workflows or activities

| Use an activity            | Use a child workflow                      |
| -------------------------- | ----------------------------------------- |
| A single side effect       | A multi-step process                      |
| Retry policy is enough     | Needs its own signals, queries, or timers |
| Short-lived                | Long-running or independently cancellable |
| Shares the parent's worker | Should run on a different task queue      |

Child workflows are heavier — each gets its own execution history. Do not reach
for one where an activity suffices.

## Error channel

| Error                         | When                                           |
| ----------------------------- | ---------------------------------------------- |
| `ChildWorkflowNotFoundError`  | The name is not on the contract you passed     |
| `ChildWorkflowError`          | The child failed, timed out, or was terminated |
| `ChildWorkflowCancelledError` | The child was cancelled                        |

`result()` narrows further — it cannot return `ChildWorkflowNotFoundError`,
because resolution already succeeded.

## Next

- [Handle cancellation](/how-to/handle-cancellation)
- [Continue as new](/how-to/continue-as-new)
- [Worker surface](/reference/worker-surface)
