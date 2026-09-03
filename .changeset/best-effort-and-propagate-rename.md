---
"@temporal-contract/worker": minor
---

`bestEffort(result, onFailure)` — the counterpart to `propagateFailure` for a
non-critical call (a notification, a metric, an audit write). It hands the
failure to `onFailure` and resolves `undefined` instead of ending the workflow,
but **re-raises real cancellation** (`ActivityCancelledError`,
`ChildWorkflowCancelledError`, `WorkflowCancelledError`) so a workflow can no
longer absorb its own cancel by accident. That rule used to live in every
hand-written best-effort fold; it is now structural.

`propagateActivityFailure` is renamed to **`propagateFailure`** — it has always
also handled child-workflow calls and cancellation scopes, and the old name said
otherwise. The old name stays as a deprecated alias (the identical function
reference) and will be removed in the next major.
