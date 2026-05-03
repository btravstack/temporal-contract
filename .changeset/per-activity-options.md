---
"@temporal-contract/worker": minor
"@temporal-contract/contract": minor
"@temporal-contract/client": minor
"@temporal-contract/boxed": minor
"@temporal-contract/testing": minor
---

`declareWorkflow` accepts a new optional `activityOptionsByName` field for
per-activity `ActivityOptions` overrides.

Closes #122.

Today, `activityOptions` applies to every activity reachable from the
workflow. `activityOptionsByName` lets you override timeouts, retry policy,
or any other Temporal `ActivityOptions` field for individual activities:

```ts
declareWorkflow({
  workflowName: "processOrder",
  contract,
  activityOptions: {
    startToCloseTimeout: "1 minute", // default for all activities
  },
  activityOptionsByName: {
    // Payment gateway is slow — give it room and retry aggressively.
    chargePayment: {
      startToCloseTimeout: "5 minutes",
      retry: { maximumAttempts: 5 },
    },
    // Cheap CPU-bound check — fail fast if it stalls.
    validateOrder: { startToCloseTimeout: "5 seconds" },
  },
  implementation: ...,
});
```

Each entry shallow-merges over the workflow default. The override wins on
every property it specifies, including the entire nested `retry` block —
this matches Temporal's "one `ActivityOptions` per `proxyActivities` call"
semantics, where each scheduled activity carries one full options bag.

Activity names are typed against the contract (workflow-local + global), so
typos surface at compile time rather than running silently with the default
options.

Non-breaking: existing workflows that only use `activityOptions` are
unchanged.
