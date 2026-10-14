# Run activities on a dedicated queue

Some activities belong to their own worker pool: PDF rendering, a
rate-limited LLM call, a flaky third party. Give them an **activity-only
contract** — its `taskQueue` is the pool's queue, and its worker is the one
that polls it:

```typescript
import { defineActivity, defineContract } from "@temporal-contract/contract";
import { z } from "zod";

const renderInvoice = defineActivity({
  input: z.object({ invoiceId: z.string() }),
  output: z.object({ url: z.string() }),
  errors: {
    InvoiceNotFound: { data: z.object({ invoiceId: z.string() }), nonRetryable: true },
  },
  activityOptions: { startToCloseTimeout: "2 minutes", retry: { maximumAttempts: 3 } },
});

export const pdfContract = defineContract({
  taskQueue: "pdf",
  workflows: {},
  activities: { renderInvoice },
});
```

Serve it like any contract: `declareActivitiesHandler({ contract: pdfContract,
activities })`, registered on a worker polling `pdfContract.taskQueue`.

The activity can then be called from a workflow of another contract, or
directly from a client with no workflow at all.

## From a workflow

`context.executeActivity` takes the target contract first, like
[`executeChildWorkflow`](/how-to/run-child-workflows). The task queue comes
from that contract:

```typescript
import { declareWorkflow, propagateFailure } from "@temporal-contract/worker/workflow";

import { orderContract } from "./order.contract.js";
import { pdfContract } from "./pdf.contract.js";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: orderContract,
  activityOptions: { startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3 } },
  implementation: async (context, order) => {
    const { url } = await propagateFailure(
      context.executeActivity(pdfContract, "renderInvoice", {
        args: { invoiceId: order.invoiceId },
      }),
    );
    return { status: "completed", invoiceUrl: url };
  },
});
```

The call behaves like `context.activities.X`: `args` is validated before
dispatch, the result is parsed on receive, and failures come back as the
activity's declared errors, `ActivityError` or `ActivityCancelledError`.

Options merge shallowly, least to most specific: the workflow's
`activityOptions`, the activity's contract-level `activityOptions`, then any
`ActivityOptions` passed beside `args`. `taskQueue` is not accepted: it is
always the target contract's. The merged options need a per-attempt and a
total bound, as for every activity; an unbounded call is a defect carrying a
`ContractMisuseError`.

Compared with an [`activityOptionsByName` `taskQueue`
override](/how-to/tune-activity-options#route-an-activity-to-another-task-queue),
the queue name is written once, on the contract whose worker polls it, rather
than once per calling workflow, and no workflow can forget it.

## From a client (standalone activities)

A client can run a contract's global activity directly, with no workflow
around it: Temporal's [standalone
activities](https://docs.temporal.io/standalone-activity). They need
**Temporal Server 1.32 or later**.

```typescript
import { CONTRACT_ERROR_TAG, ACTIVITY_EXECUTE_PATTERNS } from "@temporal-contract/client";
import { P } from "unthrown";

const pdf = typedClient.for(pdfContract);

const result = await pdf.executeActivity("renderInvoice", {
  activityId: `invoice-${invoiceId}`,
  args: { invoiceId },
});

result.match({
  ok: ({ url }) => console.log("rendered", url),
  errCases: (matcher) =>
    matcher
      .with(P.tag(CONTRACT_ERROR_TAG), (error) => console.warn(error.errorName, error.data))
      .with(...ACTIVITY_EXECUTE_PATTERNS, (error) => console.error(error)),
  defect: (cause) => console.error("unexpected failure", cause),
});
```

The worker side needs nothing new: `declareActivitiesHandler` already
registers each activity under its name on the contract's queue, so a
standalone call runs the same input validation and failure mapping.

- **`startActivity(name, options)`** returns a `TypedActivityHandle` as soon
  as the activity starts. Errors: `ActivityValidationError`,
  `ActivityAlreadyStartedError`.
- **`executeActivity(name, options)`** is `startActivity` followed by
  `handle.result()`.
- **`getActivityHandle(name, activityId, { runId? })`** reattaches to an existing
  execution, synchronously.

The handle's `result()` decodes the activity's declared errors into typed
`ContractError`s, and reports a cancelled, terminated or timed-out activity as
`ActivityCancelledError`, `ActivityTerminatedError` or `ActivityTimeoutError`.
Any other failure is an `ActivityFailedError`. `describe()`, `cancel()` and
`terminate()` return `ActivityExecutionNotFoundError` for an unknown ID.
`raw` is Temporal's `ActivityHandle`, for `pause`, `updateOptions` and the
rest.

The activity's contract-level `activityOptions` are the defaults; options
passed in the call shallow-merge over them. As inside a workflow, the merged
options need a per-attempt and a total bound, or the call is a defect.

`idConflictPolicy` accepts `"FAIL"` (the default) and `"USE_EXISTING"`. Under
`"USE_EXISTING"`, a running execution of another activity type or queue
holding the ID is reported as `ActivityAlreadyStartedError`.
Temporal has no `TerminateExisting` for activities.

::: warning No calling workflow
A standalone call has no workflow. In activity middleware,
`ActivityInvocationInfo.workflowName` is still the activity's registration
scope, but `Context.current().info.workflowExecution` is absent: fall back to
`activityId`.
:::
