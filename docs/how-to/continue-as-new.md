# Continue as new

Every workflow event is recorded in its history. A workflow that loops forever
— a subscription poller, a long-lived state machine, a per-entity actor — grows
its history without bound until Temporal refuses to continue.

`continueAsNew` ends the current run and atomically starts a fresh one with new
arguments and an empty history.

## The basic pattern

```typescript
import { declareWorkflow, propagateActivityFailure } from "@temporal-contract/worker/workflow";
import { sleep } from "@temporalio/workflow";

export const pollSubscription = declareWorkflow({
  workflowName: "pollSubscription",
  contract: billingContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, args) => {
    for (let i = 0; i < 100; i += 1) {
      await propagateActivityFailure(
        context.activities.chargeSubscription({ subscriptionId: args.subscriptionId }),
      );
      await sleep("30 days");
    }

    // 100 cycles is enough history. Start over with a clean slate.
    return context.continueAsNew({
      subscriptionId: args.subscriptionId,
      cycle: args.cycle + 100,
    });
  },
});
```

`continueAsNew` never returns — its type is `Promise<never>`. Returning it is
the idiomatic way to make that obvious and to satisfy the implementation's
return type.

Arguments are validated against the destination workflow's input schema
_before_ Temporal is called. An invalid payload throws
`WorkflowInputValidationError` rather than starting a broken run.

## Decide when to roll over

Base the decision on something deterministic. `context.info` exposes Temporal's
`WorkflowInfo`:

```typescript
implementation: async (context, args) => {
  let processed = args.processed;
  let cursor = args.cursor;

  while (true) {
    const batch = await propagateActivityFailure(context.activities.fetchBatch({ cursor }));
    if (batch.items.length === 0) {
      return { processed };
    }

    await propagateActivityFailure(context.activities.processBatch({ items: batch.items }));
    processed += batch.items.length;
    cursor = batch.nextCursor; // advance, so the next fetch makes progress

    // Temporal's own signal that history is getting long.
    if (context.info.continueAsNewSuggested) {
      return context.continueAsNew({ cursor, processed });
    }
  }
};
```

`continueAsNewSuggested` is set by the server based on real history size. It is
a better trigger than a hand-tuned iteration count.

## Carry state forward

The new run starts with empty memory. Anything that must survive has to travel
in the arguments — which means the contract's input schema has to accommodate
it:

```typescript
const pollSubscription = defineWorkflow({
  input: z.object({
    subscriptionId: z.string(),
    // Continuation state, defaulted so the first run can omit it.
    cycle: z.number().int().nonnegative().default(0),
    lastChargeId: z.string().optional(),
  }),
  output: z.object({ cycles: z.number() }),
});
```

Keep it small. These arguments are serialized into the new run's history on
every rollover.

## Continue into a different workflow

The four-argument form takes a contract and a workflow name, so a run can hand
off to a different workflow type — including one on another contract and task
queue:

```typescript
implementation: async (context, args) => {
  if (args.phase === "collection") {
    // Hand off to the dunning workflow on the collections contract.
    return context.continueAsNew(collectionsContract, "dunningProcess", {
      accountId: args.accountId,
      overdueSince: args.overdueSince,
    });
  }
  // ...
};
```

Arguments are validated against the _destination_ workflow's schema.

## Options

```typescript
return context.continueAsNew(
  { subscriptionId: args.subscriptionId, cycle: args.cycle + 1 },
  {
    workflowRunTimeout: "7 days",
    workflowTaskTimeout: "10 seconds",
    memo: { tenant: args.tenantId },
  },
);
```

`TypedContinueAsNewOptions` is Temporal's `ContinueAsNewOptions` minus
`workflowType` and `taskQueue` (derived from the contract, and ignored if you
try to set them). There is no `retry` option — a continued run inherits the
chain's retry policy; use activity retry policies for step-level retries.

## Drain handlers first

Rolling over while a signal or update handler is mid-flight drops that work:

```typescript
import { allHandlersFinished, condition } from "@temporalio/workflow";

if (context.info.continueAsNewSuggested) {
  await condition(() => allHandlersFinished());
  return context.continueAsNew({ cursor, processed });
}
```

## What callers see

The workflow id stays the same; the run id changes. A client that holds a
handle and awaits `result()` transparently follows the chain and receives the
value returned by the _final_ run.

Signals sent during the rollover window are delivered to the new run. Queries
against a completed run see that run's final state — bind by workflow id rather
than run id to always reach the current one.

## Do not use it for

- **Retrying a failed step.** That is what activity retry policies are for.
- **Splitting unrelated work.** Use [child
  workflows](/how-to/run-child-workflows).
- **Short workflows.** If history will not grow unbounded, the extra complexity
  buys nothing.

## Next

- [Run child workflows](/how-to/run-child-workflows)
- [Workflow determinism](/explanation/workflow-determinism)
- [Worker surface](/reference/worker-surface)
