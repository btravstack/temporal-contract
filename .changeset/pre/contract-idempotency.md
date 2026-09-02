---
"@temporal-contract/contract": major
"@temporal-contract/client": major
"@temporal-contract/worker": major
"@temporal-contract/testing": major
---

Workflows must now declare an `idempotency` mode. The client applies it to every `startWorkflow` / `executeWorkflow` / `signalWithStart`, and the worker applies it to every `context.startChildWorkflow` / `context.executeChildWorkflow` of that workflow. It is **not** applied to `schedule.create` — `ScheduleOptionsStartWorkflowAction` has no `workflowIdReusePolicy` field, so a schedule action pinning a fixed `workflowId` gets Temporal's own default (`ALLOW_DUPLICATE`) regardless of the contract's declared mode.

Temporal's `workflowIdReusePolicy` defaults to `ALLOW_DUPLICATE`, which permits
starting a new run when a previous run with the same workflow ID has **closed —
including completing successfully**. For a workflow keyed `charge-${orderId}`, a
retried start after a successful charge starts a second charge.

Declare the intent once, on the contract:

```ts
defineWorkflow({
  input,
  output,
  idempotency: "retry-if-failed", // re-runnable only if the previous run didn't succeed
});
```

| Mode                | Temporal policy               | Meaning                                                                                                                           |
| ------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `"once-per-id"`     | `REJECT_DUPLICATE`            | this workflow ID may run exactly once, ever                                                                                       |
| `"retry-if-failed"` | `ALLOW_DUPLICATE_FAILED_ONLY` | re-runnable only if the previous run reached a Closed state **other than Completed** — Failed, Cancelled, Terminated, or TimedOut |
| `"allow-duplicate"` | `ALLOW_DUPLICATE`             | Temporal's own default — unconditionally re-runnable after any Closed run                                                         |

**Breaking:** the field is required. Existing workflows keep their exact current
behavior with `"allow-duplicate"` — but the field is required precisely so the
question gets asked once per workflow rather than inherited silently. (Temporal's
own default is still `ALLOW_DUPLICATE`, and still governs `schedule.create`
starts unconditionally — what changed is temporal-contract's effective
behavior on the paths it does control.)

`workflowIdConflictPolicy` is unchanged and remains a per-call option: whether
re-running is safe is a property of the operation, while what to do about a run
already in flight is a property of the call. An explicit per-call
`workflowIdReusePolicy` still overrides the contract's mode.
