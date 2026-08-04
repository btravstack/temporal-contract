# Tune activity options

Every activity call needs timeouts, and most need a retry policy. There are
three places to set them, merged from least to most specific.

## The merge order

```
declareWorkflow({ activityOptions })          ← workflow-wide default
        ↓ overridden by
defineActivity({ activityOptions })           ← the activity's own contract default
        ↓ overridden by
declareWorkflow({ activityOptionsByName })    ← explicit per-activity override
```

Each level **shallow-merges** over the one before. An override wins on every
property it names — including the whole nested `retry` block, which is replaced
rather than merged. That matches Temporal's own
single-options-per-`proxyActivities` semantics.

## Set a workflow-wide default

```typescript
export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderContract,
  activityOptions: {
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 3 },
  },
  implementation: async (context, order) => {
    /* ... */
  },
});
```

Applies to every activity reachable from this workflow — workflow-scoped and
global alike.

## Ship a default with the contract

Operational characteristics that belong to the activity itself, not to a
particular caller, go on the contract:

```typescript
const sendNotification = defineActivity({
  input: NotificationSchema,
  output: z.void(),
  activityOptions: {
    startToCloseTimeout: "30 seconds",
    retry: { maximumAttempts: 5 },
  },
});
```

Now every workflow that calls `sendNotification` gets those settings without
repeating them.

::: tip `activityOptions` is strict
Unknown keys are rejected at `defineContract` time. A typo like
`startToCloseTimeOut` fails immediately instead of being silently dropped when
the worker merges options. Duration strings are validated there too, against
the `ms` grammar (`"30 seconds"`, `"5m"`, `"1.5h"`) — so `"5 minutos"` fails at
definition instead of surfacing later as an opaque worker error.
:::

## Override per activity

```typescript
export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderContract,
  activityOptions: {
    startToCloseTimeout: "1 minute", // default for everything
    retry: { maximumAttempts: 3 }, // so an activity relying on the default alone still has a total bound
  },
  activityOptionsByName: {
    chargeCard: {
      startToCloseTimeout: "5 minutes",
      retry: { maximumAttempts: 5, initialInterval: "2 seconds" },
    },
    refundPayment: {
      startToCloseTimeout: "5 minutes",
      retry: { maximumAttempts: 10 }, // refunds must not be dropped
    },
  },
  implementation: async (context, order) => {
    /* ... */
  },
});
```

Activity names are typed against the contract — a typo is a compile error, not
a silent fallback to the default.

## Route an activity to another task queue

`activityOptionsByName` accepts Temporal's full `ActivityOptions`, `taskQueue`
included. That lets you send specific activities to a dedicated worker pool
while the rest stay on the contract's queue:

```typescript
activityOptionsByName: {
  // Concurrency-capped GPU pool.
  scoreRisk: {
    taskQueue: "ml-inference",
    startToCloseTimeout: "2 minutes",
  },
  // Isolated pool for a flaky third party.
  syncLegacyErp: {
    taskQueue: "legacy-integration",
    startToCloseTimeout: "10 minutes",
    retry: { maximumAttempts: 2 },
  },
}
```

Doing this through `activityOptionsByName` keeps the validated, typed activity
boundary intact — a raw `proxyActivities({ taskQueue })` would forfeit it.

## Pick the right timeout

| Option                   | Bounds                            | Use it for                                                   |
| ------------------------ | --------------------------------- | ------------------------------------------------------------ |
| `startToCloseTimeout`    | A single attempt                  | Almost always. Set it to the longest a healthy attempt takes |
| `scheduleToCloseTimeout` | Queuing + all retries, end to end | An overall deadline for the operation                        |
| `scheduleToStartTimeout` | Time waiting in the queue         | Detecting an under-provisioned worker fleet                  |
| `heartbeatTimeout`       | Gap between heartbeats            | Long activities; required for them to be cancellable         |

At least one of `startToCloseTimeout` or `scheduleToCloseTimeout` is required.
`startToCloseTimeout` is the one you want by default — with only
`scheduleToCloseTimeout`, a single hung attempt consumes the entire budget and
never retries.

## Configure retries

```typescript
retry: {
  initialInterval: "1 second",   // delay before the first retry
  backoffCoefficient: 2,          // 1s, 2s, 4s, 8s...
  maximumInterval: "100 seconds", // cap on the delay
  maximumAttempts: 5,             // 0 = unlimited
  nonRetryableErrorTypes: ["CARD_DECLINED", "INVALID_ADDRESS"],
}
```

`nonRetryableErrorTypes` matches the `type` on the `ApplicationFailure` — the
same string you pass to [`qualifyFailure`](/how-to/implement-activities), or the key
of a [declared contract error](/how-to/model-domain-errors).

Two ways to make a failure permanent:

```typescript
// Per call site — this instance is permanent. `expected` is always required;
// `nonRetryable: true` opts this wrapper out of the retry policy.
qualifyFailure("CARD_DECLINED", { expected: GatewayError, nonRetryable: true });

// From the contract — every instance of this declared error is permanent.
errors: {
  CardDeclined: { data: z.object({ reason: z.string() }), nonRetryable: true },
}
```

Prefer the contract declaration: it puts retry semantics next to the error's
definition, where every caller can see them.

## Every reachable activity needs both bounds

`activityOptions` on `declareWorkflow` is optional in isolation, but every
activity reachable from the workflow — workflow-scoped and global alike —
must end up, in its **merged** options, with both:

- a per-attempt bound (`startToCloseTimeout` or `scheduleToCloseTimeout`)
- a total bound (`scheduleToCloseTimeout`, or a finite positive
  `retry.maximumAttempts`)

`scheduleToCloseTimeout` alone satisfies both. This is checked on the merge
of all three layers from "The merge order" above, not on any one layer in
isolation — because the merge is shallow, a workflow-wide `retry` block can
be silently replaced by a contract-level or per-name `retry` block that
omits `maximumAttempts`, even though both looked bounded on their own.

If any reachable activity's merged options miss a bound, `declareWorkflow`
throws `ContractMisuseError` at declaration time, naming every offender and
which rule it broke:

```
declareWorkflow: every reachable activity needs a total bound, so a failing activity
cannot retry forever. These do not:
  - sendReceipt: missing a total bound (set `scheduleToCloseTimeout`, or a finite positive `retry.maximumAttempts`)
Options are merged from `declareWorkflow`'s `activityOptions`, the contract's
`defineActivity({ activityOptions })`, and `activityOptionsByName`. That merge is
shallow, so a later layer's `retry` replaces an earlier layer's entirely — check the
merged result, not each layer.
```

This check runs while the workflow bundle is being evaluated, before
Temporal ever invokes the workflow function — so it does **not** fail the
execution. It stalls the workflow via indefinite workflow-task retry, the
same way the plain `TypeError` this check replaces always did for a missing
per-attempt bound. That is deliberate: it lets a bad deploy be fixed and
redeployed with in-flight executions resuming, rather than terminally
failing every in-flight execution on a bad deploy. See
[Worker surface → Activity bounds](/reference/worker-surface#activity-bounds)
for the full explanation, including the `maximumAttempts` edge cases. The
value here is at declaration time, in development and CI — not as a
production runtime safety net.

## Next

- [Implement activities](/how-to/implement-activities)
- [Model domain errors](/how-to/model-domain-errors)
- [Contract surface](/reference/contract-surface)
