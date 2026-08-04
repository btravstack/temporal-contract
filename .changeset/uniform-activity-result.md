---
"@temporal-contract/worker": major
---

Every workflow-side activity call now returns `AsyncResult`.

Previously the call convention depended on whether the contract declared an
`errors` map: activities with declared errors returned `AsyncResult`, those
without returned a `Promise` that threw. The call site gave no indication
which applied, and the throwing path contradicted the library's own
"activities never throw" convention.

**Migrating.** Where the workflow should handle the failure, narrow it:

```ts
const result = await context.activities.charge(input);
if (result.isErr()) {
  /* ... */
}
```

Where the failure should escape and let Temporal fail the workflow, use the
new `propagateActivityFailure` helper:

```ts
import { propagateActivityFailure } from "@temporal-contract/worker/workflow";

await propagateActivityFailure(context.activities.charge(input));
```

**Do not use unthrown's `.getOrThrow()` for this.** It throws the
`ActivityError` wrapper, which is not a `TemporalFailure`; Temporal treats
that as a workflow-_task_ failure and retries it indefinitely, so the
workflow stalls until its execution timeout instead of failing. The named
`propagateActivityFailure` helper rethrows the preserved original failure,
which is exactly what escaped the workflow before this change.

**Also note:** swallowing `ActivityCancelledError` makes a workflow complete
as `Completed` rather than `Cancelled`. That hazard previously applied only
to activities declaring an `errors` map; it now applies to every activity.

**If you wrap an activity call in `cancellableScope`/`nonCancellableScope`,
this is a source break, not just a behavior change.** Both scopes are generic
over whatever `fn` returns, verbatim — they do not await it for you. Before
this change, `() => context.activities.charge(input)` returned a plain
`Promise<Output>`, so the scope's own `T` was `Output`. Now it returns an
`AsyncResult<Output, E>`, and `AsyncResult` is deliberately not a full
`PromiseLike` (no `.catch`/`.finally`), so `T` becomes the un-awaited
`AsyncResult` itself — a type with no `isOk`/`isErr`/`.value`. Code like:

```ts
const scoped = await context.cancellableScope(() => context.activities.charge(input));
if (scoped.isOk()) {
  scoped.value.transactionId; // ❌ no longer compiles — scoped.value is an AsyncResult
}
```

stops compiling. Await and narrow the activity call _inside_ the callback
instead:

```ts
const scoped = await context.cancellableScope(async () => {
  const charged = await context.activities.charge(input);
  if (charged.isDefect()) {
    throw charged.cause;
  }
  if (charged.isErr()) {
    return { ok: false as const, error: charged.error };
  }
  return { ok: true as const, value: charged.value }; // now a plain value, not an AsyncResult
});
```

`ActivityErrorsFor<TActivity>` — the error union used by
`WorkflowInferActivity`'s `AsyncResult` — is now exported from
`@temporal-contract/worker/workflow`, so consumers can name the error channel
directly (for example, to write a helper generic over an activity's error
type) instead of only the call signature.
