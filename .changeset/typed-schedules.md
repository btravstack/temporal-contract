---
"@temporal-contract/client": minor
"@temporal-contract/contract": minor
"@temporal-contract/worker": minor
"@temporal-contract/boxed": minor
"@temporal-contract/testing": minor
---

Add typed Schedules to `TypedClient` (Temporal 1.16+).

Closes #181.

```ts
const result = await client.schedule.create("processOrder", {
  scheduleId: "daily-sweep",
  spec: { cronExpressions: ["0 2 * * *"] },
  args: { orderId: "sweep" },        // typed against the workflow's input
  policies: { overlap: "SKIP" },
  workflowExecutionTimeout: "1 hour",
});

result.match({
  Ok: async (handle) => {
    await handle.pause("maintenance");
    await handle.unpause();
    await handle.trigger();
    await handle.delete();
  },
  Error: (error) => /* WorkflowNotFoundError | WorkflowValidationError | RuntimeClientError */,
});

// Existing schedule:
const handle = client.schedule.getHandle("daily-sweep");
const desc = await handle.describe();
```

## What ships

- `client.schedule.create(workflowName, options)` — validates `args` against the workflow's input schema, then calls Temporal's `client.schedule.create` with `workflowType` and `taskQueue` derived from the contract. Returns `Future<Result<TypedScheduleHandle, ...>>`.
- `client.schedule.getHandle(scheduleId)` — lifts an existing schedule handle into the typed wrapper.
- `TypedScheduleHandle` exposes `pause`, `unpause`, `trigger`, `delete`, `describe`, all wrapped in the Future/Result pattern (`Future<Result<void | ScheduleDescription, RuntimeClientError>>`).

## Scope (v1)

- Action type is **`startWorkflow` only**, matching the issue's stated v1 scope. Other Temporal action kinds aren't part of this PR.
- Schedule-level Temporal options forwarded: `policies`, `state`, `memo`, plus workflow-action–level overrides (`workflowId`, retry, timeouts, memo, etc.). `workflowType` and `taskQueue` are owned by the contract.
- The client's `schedule` field exposes a `TypedScheduleClient` instance that wraps Temporal's `Client.schedule` (mirroring how Temporal's API is organized).

## Out of scope

- Schedule lifecycle methods that don't have an obvious typed boundary (`update`, `backfill`, `readme`) — Temporal's raw types still apply; consumers can drop down to the underlying handle if needed.
- Search-attribute integration on the schedule itself — that follows after #180 ships and the worker-side typed reader lands.
