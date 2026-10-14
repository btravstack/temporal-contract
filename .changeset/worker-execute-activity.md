---
"@temporal-contract/worker": minor
---

`context.executeActivity(contract, activityName, { args, ...options })` calls a global activity of any contract on **that contract's task queue**, typically an activity-only contract served by a dedicated worker pool:

```ts
const { url } = await propagateFailure(
  context.executeActivity(pdfContract, "renderInvoice", { args: { invoiceId } }),
);
```

The queue name is written once, on the contract whose worker polls it, instead of in an `activityOptionsByName` entry per calling workflow (#452). The call validates and classifies like `context.activities.X`. Options merge `declareWorkflow`'s `activityOptions` → the activity's contract-level `activityOptions` → the per-call options, and must carry a per-attempt and a total bound.
