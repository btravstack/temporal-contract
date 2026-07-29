# Schedule workflows

Temporal schedules start workflows on a recurring spec, with catch-up policies,
pause/resume, and manual triggers. `schedule` on a contract-bound client is
the typed wrapper — the workflow type and task queue come from the contract,
and `args` are validated against its input schema before the schedule is
created:

```typescript
const ledger = typedClient.for(ledgerContract);
```

## Create a schedule

```typescript
const created = await ledger.schedule.create("reconcileLedger", {
  scheduleId: "nightly-reconcile",
  spec: {
    cronExpressions: ["0 2 * * *"], // 02:00 daily
  },
  args: { mode: "full" }, // validated against the workflow's input schema
});

if (created.isErr()) {
  console.error("could not create schedule:", created.error.message);
} else {
  console.log("scheduled:", created.value.scheduleId);
}
```

The `err` channel is narrow: `WorkflowNotInContractError` (the name is not on
the contract), `WorkflowValidationError` (the args failed the schema), or
`ScheduleAlreadyExistsError` (a running schedule already owns this id).
Technical faults — a transport error, an unrecognized rejection — ride the
defect channel with a `RuntimeClientError` cause.

## Create-if-absent

`ScheduleAlreadyExistsError` is a typed branch, so idempotent setup is a
match away — bind to the existing schedule instead of failing:

```typescript
import { P } from "unthrown";

const schedule = created.match({
  ok: (handle) => handle,
  errCases: (matcher) =>
    matcher
      .with(P.tag("@temporal-contract/ScheduleAlreadyExistsError"), () =>
        ledger.schedule.getHandle("nightly-reconcile"),
      )
      .with(
        P.tag("@temporal-contract/WorkflowNotInContractError"),
        P.tag("@temporal-contract/WorkflowValidationError"),
        (error) => {
          throw error; // programming errors — fail loudly
        },
      ),
  defect: (cause) => {
    throw cause;
  },
});
```

## Write the spec

Temporal's `ScheduleSpec` accepts calendars, intervals, or cron:

```typescript
// Every 15 minutes
spec: { intervals: [{ every: "15 minutes" }] }

// Weekdays at 09:30
spec: {
  calendars: [{
    hour: 9,
    minute: 30,
    dayOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
  }],
}

// Cron, with an explicit timezone
spec: {
  cronExpressions: ["0 2 * * *"],
  timezone: "Europe/Paris",
}

// One-off at a fixed time
spec: { calendars: [{ year: 2026, month: 12, dayOfMonth: 31, hour: 23, minute: 59 }] }
```

Set `timezone` explicitly for anything business-facing — the default is UTC, and
DST shifts will surprise you otherwise.

## Control overlap and catch-up

```typescript
await ledger.schedule
  .create("reconcileLedger", {
    scheduleId: "nightly-reconcile",
    spec: { cronExpressions: ["0 2 * * *"] },
    args: { mode: "full" },
    policies: {
      // What to do if the previous run is still going.
      overlap: "SKIP", // BUFFER_ONE | BUFFER_ALL | CANCEL_OTHER | TERMINATE_OTHER | ALLOW_ALL
      // How far back to catch up after an outage.
      catchupWindow: "1 hour",
      // Pause the whole schedule if a run fails.
      pauseOnFailure: true,
    },
  })
  .getOrThrow();
```

`overlap: "SKIP"` is the safe default for anything non-idempotent. `ALLOW_ALL`
will happily run twenty copies at once after an outage.

## Start paused

```typescript
await ledger.schedule
  .create("reconcileLedger", {
    scheduleId: "nightly-reconcile",
    spec: { cronExpressions: ["0 2 * * *"] },
    args: { mode: "full" },
    state: {
      paused: true,
      note: "awaiting sign-off",
      // Fire a fixed number of times then stop.
      remainingActions: 10,
    },
  })
  .getOrThrow();
```

## Override the spawned workflow

`action` carries workflow-level overrides for each run:

```typescript
await ledger.schedule
  .create("reconcileLedger", {
    scheduleId: "nightly-reconcile",
    spec: { cronExpressions: ["0 2 * * *"] },
    args: { mode: "full" },
    memo: { owner: "platform" }, // metadata on the schedule itself
    action: {
      workflowExecutionTimeout: "2 hours",
      retry: { maximumAttempts: 2 },
      memo: { kind: "scheduled-run" }, // metadata on each spawned workflow
    },
  })
  .getOrThrow();
```

::: tip Two different memos
The top-level `memo` describes the schedule. `action.memo` is attached to every
workflow the schedule starts. They have separate lifecycles, which is why they
are nested separately.
:::

`workflowType` and `taskQueue` are owned by the contract and are not settable.

## Index the spawned runs

```typescript
await ledger.schedule
  .create("reconcileLedger", {
    scheduleId: "nightly-reconcile",
    spec: { cronExpressions: ["0 2 * * *"] },
    args: { mode: "full" },
    searchAttributes: {
      priority: 5,
      tags: ["scheduled"],
    },
  })
  .getOrThrow();
```

Keys and value types are constrained to what the workflow declares. See
[Index workflows with search
attributes](/how-to/index-workflows-with-search-attributes).

## Manage a schedule

The handle mirrors Temporal's lifecycle methods, wrapped in `AsyncResult`:

```typescript
const created = await ledger.schedule.create("reconcileLedger", {/* ... */});
if (created.isErr()) throw created.error;

const schedule = created.value;

// `.get()` rethrows a defect's original cause. Without it, `await` merely
// collapses the AsyncResult to a Result and the failure is discarded.
await schedule.pause("incident #4821").get();
await schedule.unpause("incident resolved").get();

// Run it right now, without waiting for the next tick.
await schedule.trigger().get();

// Inspect current state.
const described = await schedule.describe();
if (described.isErr()) {
  console.error("schedule is gone:", described.error.scheduleId);
} else if (described.isDefect()) {
  console.error("describe failed:", described.cause);
} else {
  console.log(described.value.state.paused, described.value.info.nextActionTimes);
}

await schedule.delete().get();
```

Every method returns `AsyncResult<T, ScheduleNotFoundError>` — the one
anticipated failure, a schedule the server no longer knows, is a typed `Err`.
Anything else (a transport failure, an unrecognized rejection) is a technical
fault on the defect channel.

::: warning `await` alone does not surface the failure
`AsyncResult` is a success-only thenable: awaiting it yields a `Result`, and the
underlying promise never rejects. `await schedule.pause(...)` therefore discards
a failure silently. Chain `.get()` (which rethrows an `Err` or a defect's
original cause) or branch on `isErr()` / `isDefect()` — the same applies to
every `AsyncResult` in this library.
:::

## Update or backfill a schedule

`update` is fetch-modify-persist: Temporal hands your function the current
description and persists what it returns. It may be invoked more than once on
conflict — keep it pure:

```typescript
await schedule
  .update((previous) => ({
    ...previous,
    spec: { cronExpressions: ["0 3 * * *"] }, // move to 03:00
  }))
  .get();
```

The action's `workflowType` / `taskQueue` / `args` are **not** re-validated
against the contract here — for contract-level changes, prefer delete +
`create`.

`backfill` runs the schedule's action over historical time ranges, as if the
schedule had been active then:

```typescript
await schedule
  .backfill({
    start: new Date("2026-07-01T00:00:00Z"),
    end: new Date("2026-07-08T00:00:00Z"),
    overlap: "ALLOW_ALL",
  })
  .get();
```

## Reach an existing schedule

`getHandle` binds to a schedule this process did not create. It is
synchronous and does no server round-trip — a wrong id surfaces as
`Err(ScheduleNotFoundError)` from the handle's methods:

```typescript
const handle = ledger.schedule.getHandle("nightly-reconcile");
await handle.pause("manual intervention").get();
```

## List schedules

`list` is a passthrough of Temporal's `ScheduleClient.list` — an
`AsyncIterable` of summaries across the namespace (not filtered to the
contract):

```typescript
for await (const summary of ledger.schedule.list()) {
  console.log(summary.scheduleId, summary.action);
}
```

## Schedules or `sleep`?

| Use a schedule                         | Use a looping workflow              |
| -------------------------------------- | ----------------------------------- |
| Fixed calendar or cron cadence         | Cadence depends on workflow state   |
| Each run is independent                | State carries across runs           |
| Operators need to pause/trigger it     | Fully autonomous                    |
| Missed runs should catch up per policy | Timing is relative to the last step |

For the second column, a workflow that `sleep`s and calls
[`continueAsNew`](/how-to/continue-as-new) is usually the better fit.

## Next

- [Index workflows with search attributes](/how-to/index-workflows-with-search-attributes)
- [Client surface](/reference/client-surface)
- [Continue as new](/how-to/continue-as-new)
