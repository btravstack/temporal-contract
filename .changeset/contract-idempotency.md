---
"@temporal-contract/contract": major
---

Workflows must now declare an `idempotency` mode. The client applies it to every start, and the worker applies it to every child-workflow start of that workflow.

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
| `"allow-duplicate"` | `ALLOW_DUPLICATE`             | Temporal's previous default                                                                                                       |

**Breaking:** the field is required. Existing workflows keep their exact current
behavior with `"allow-duplicate"` — but the field is required precisely so the
question gets asked once per workflow rather than inherited silently.

`workflowIdConflictPolicy` is unchanged and remains a per-call option: whether
re-running is safe is a property of the operation, while what to do about a run
already in flight is a property of the call. An explicit per-call
`workflowIdReusePolicy` still overrides the contract's mode.
