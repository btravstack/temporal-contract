---
"@temporal-contract/worker": major
---

Two safety requirements are now enforced instead of assumed.

**Every activity needs a per-attempt bound and a total bound.** `declareWorkflow` now checks the MERGED options for every reachable activity — `activityOptions` → the activity's contract-level `defineActivity({ activityOptions })` → `activityOptionsByName`, shallow-merged in that order — instead of checking presence per source. A per-attempt bound (`startToCloseTimeout` or `scheduleToCloseTimeout`) and a total bound (`scheduleToCloseTimeout`, or a finite positive `retry.maximumAttempts`) must both survive the merge; `scheduleToCloseTimeout` alone satisfies both. `Infinity` does not count as a bound (Temporal drops it because it already is the default), and neither does `<= 0` or a non-integer — those are left to Temporal's own `ValueError` validation. A violation throws one `ContractMisuseError` naming every offending activity and which bound(s) it lacks:

```
declareWorkflow: every reachable activity needs a total bound, so a failing activity
cannot retry forever. These do not:
  - chargePayment: missing a total bound (set `scheduleToCloseTimeout`, or a finite positive `retry.maximumAttempts`)
Options are merged from `declareWorkflow`'s `activityOptions`, the contract's
`defineActivity({ activityOptions })`, and `activityOptionsByName`. That merge is
shallow, so a later layer's `retry` replaces an earlier layer's entirely — check the
merged result, not each layer.
```

Migration: give the merged result for each named activity either `scheduleToCloseTimeout`, or both `startToCloseTimeout` and a finite positive `retry.maximumAttempts`. Watch the shallow-merge trap specifically — a later layer's `retry` block replaces an earlier layer's entirely, so a workflow-wide `retry: { maximumAttempts: 3 }` can be silently dropped by a contract-level `retry: { initialInterval: "2s" }` that wins the merge for a given activity, even though both looked bounded in isolation.

This check runs at module top level (workflow-bundle load), the same place the `TypeError` it replaces always ran. A violation therefore stalls the workflow via indefinite workflow-task retry rather than failing the execution — `ContractMisuseError`'s `nonRetryable` flag has no effect here, since this path never emits a `FailWorkflowExecution` command. That is deliberate: it lets a bad deploy be fixed and redeployed with in-flight executions resuming. The guard's value is at declaration time in development and CI, not as a production runtime safety net — see the "Activity bounds" section of the worker-surface reference for the full explanation.

**`parentClosePolicy` is required on every child workflow call.** `TypedChildWorkflowOptions` (`context.startChildWorkflow` / `context.executeChildWorkflow`) now requires `parentClosePolicy`, typed `"TERMINATE" | "REQUEST_CANCEL" | "ABANDON"` with `undefined` explicitly excluded — an omitted field, or an explicit `undefined`, is a TypeScript compile error. `"TERMINATE"` reproduces the previous behavior exactly (Temporal's own default, kill the child when the parent closes); the change is that it must be written down at the call site instead of inherited silently, since a wrong-by-default `TERMINATE` on a mid-payment child was the risk this closes.

Migration: add `parentClosePolicy` to every `startChildWorkflow`/`executeChildWorkflow` call. Use it as a prompt to actually choose per call site — `REQUEST_CANCEL` where a child needs to compensate before exiting, `ABANDON` for fire-and-forget work that should outlive its parent — rather than mechanically filling in `"TERMINATE"` everywhere.

See the [upgrade guide](https://btravstack.github.io/temporal-contract/how-to/upgrade-to-v8) for both changes in full, including the exact error text.
