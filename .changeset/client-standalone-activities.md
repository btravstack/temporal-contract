---
"@temporal-contract/client": minor
"@temporal-contract/contract": patch
---

Run a contract's global activity as a **standalone activity**, with no workflow around it (Temporal Server ≥ 1.32):

```ts
const result = await client.for(pdfContract).executeActivity("renderInvoice", {
  activityId: `invoice-${invoiceId}`,
  args: { invoiceId },
});
```

`ContractClient` gains `startActivity`, `executeActivity` and `getActivityHandle`. The task queue comes from the contract, `args` is validated before the start, and the result is parsed against the output schema. The handle's `result()` decodes the activity's declared errors into typed `ContractError`s and reports the outcomes as first-class errors: `ActivityCancelledError`, `ActivityTerminatedError`, `ActivityTimeoutError`, otherwise `ActivityFailedError`. `describe`, `cancel` and `terminate` err with `ActivityExecutionNotFoundError`, and a duplicate start with `ActivityAlreadyStartedError`. The activity's contract-level `activityOptions` are the call's defaults, and the merged options need a per-attempt and a total bound. New pattern groups: `ACTIVITY_START_PATTERNS`, `ACTIVITY_RESULT_PATTERNS`, `ACTIVITY_EXECUTE_PATTERNS`.

The worker side needs nothing new: `declareActivitiesHandler` already registers each activity under its name on the contract's queue.
