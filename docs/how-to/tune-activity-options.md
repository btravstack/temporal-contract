# Tune activity options

Every activity call needs timeouts, and most need a retry policy. There are
three places to set them, merged from least to most specific.

## The merge order

```
declareWorkflow({ activityOptions })          ← workflow-wide default
        ↓ overridden by
defineActivity({ defaultOptions })            ← the activity's own contract default
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
  defaultOptions: {
    startToCloseTimeout: "30 seconds",
    retry: { maximumAttempts: 5 },
  },
});
```

Now every workflow that calls `sendNotification` gets those settings without
repeating them.

::: tip `defaultOptions` is strict
Unknown keys are rejected at `defineContract` time. A typo like
`startToCloseTimeOut` fails immediately instead of being silently dropped when
the worker merges options.
:::

## Override per activity

```typescript
export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderContract,
  activityOptions: {
    startToCloseTimeout: "1 minute", // default for everything
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
// Per call site — this instance is permanent.
qualifyFailure("CARD_DECLINED", { nonRetryable: true });

// From the contract — every instance of this declared error is permanent.
errors: {
  CardDeclined: { data: z.object({ reason: z.string() }), nonRetryable: true },
}
```

Prefer the contract declaration: it puts retry semantics next to the error's
definition, where every caller can see them.

## Omitting `activityOptions`

`activityOptions` is optional _if_ every reachable activity is covered by a
contract-level `defaultOptions` or an `activityOptionsByName` entry. If some
activity has neither, `declareWorkflow` throws at declaration time and names
the uncovered activities — a startup failure rather than a runtime one.

## Next

- [Implement activities](/how-to/implement-activities)
- [Model domain errors](/how-to/model-domain-errors)
- [Contract surface](/reference/contract-surface)
