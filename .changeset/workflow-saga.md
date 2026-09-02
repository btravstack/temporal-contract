---
"@temporal-contract/worker": minor
---

`context.saga()`: steps with compensating undos, unwound LIFO — with the
machinery failures exempt by default.

`declareWorkflow` handed a workflow `context.activities` and `context.errors`
and nothing for the walk-back, so every saga wrote its own. The LIFO machinery
is now `@unthrown/saga`'s. What this adds is the decision that belongs to
Temporal rather than to a `Result` combinator: **which failures compensate.**

```ts
const fulfilled = await context
  .saga()
  .step(
    () => context.activities.reserveStock(order),
    (reservation) => context.activities.releaseStock({ id: reservation.id }),
  )
  .step(
    () => context.activities.chargeCard(order),
    (charge) => context.activities.refund({ id: charge.id }),
  )
  .step(() => context.activities.ship(order))
  .run();
```

The undos run on a **declared contract error** — a permanent domain answer,
where what the step did before saying no is knowable. They do **not** run on an
`ActivityError`, a `ChildWorkflowError` or a defect: a step that failed
unmodelled left state nobody can see, and un-deciding what you cannot see is a
second bug. That failure propagates untouched, so `propagateActivityFailure`
still re-raises Temporal's original failure — which deletes the per-step

```ts
.with(P.tag(ACTIVITY_ERROR_TAG), P.tag(ACTIVITY_CANCELLED_ERROR_TAG), (error) => ErrAsync(error))
```

arm that had to be repeated, was easy to omit, and was invisible when omitted.

Cancellation is the one case a caller may opt back in to, with
`saga({ compensateOnCancellation: true })`. Every undo runs inside a
non-cancellable scope: a cancelled scope schedules no activity at all, so
without one that opt-in could never compensate for the failure it exists for.
A compensation that itself fails
becomes a defect carrying its own failure, which outranks the failure that
triggered the unwind — a refund that never happened is worse news than the order
that could not ship — and the remaining undos still run first.

`workflowSaga` is the same function, exported from
`@temporal-contract/worker/workflow` for a workflow that composes its steps in a
helper.

Closes #413.
