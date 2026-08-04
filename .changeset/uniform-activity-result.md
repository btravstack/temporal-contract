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

`ActivityErrorsFor<TActivity>` — the error union used by
`WorkflowInferActivity`'s `AsyncResult` — is now exported from
`@temporal-contract/worker/workflow`, so consumers can name the error channel
directly (for example, to write a helper generic over an activity's error
type) instead of only the call signature.
