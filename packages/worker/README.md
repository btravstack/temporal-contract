# @temporal-contract/worker

> Type-safe worker implementation for Temporal

[![npm version](https://img.shields.io/npm/v/@temporal-contract/worker.svg?logo=npm)](https://www.npmjs.com/package/@temporal-contract/worker)

## Installation

```bash
pnpm add @temporal-contract/worker @temporal-contract/contract @temporalio/workflow zod
```

## Quick Example

```typescript
// activities.ts
import { declareActivitiesHandler, ApplicationFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

import { myContract } from "./contract.js";

export const activities = declareActivitiesHandler({
  contract: myContract,
  activities: {
    sendEmail: ({ to, body }) =>
      fromPromise(emailService.send({ to, body }), (error) =>
        ApplicationFailure.create({
          type: "EMAIL_FAILED",
          message: error instanceof Error ? error.message : "Failed to send email",
          // Omit `cause` entirely for non-Error rejections — don't pass undefined.
          ...(error instanceof Error ? { cause: error } : {}),
        }),
      ).map(() => ({ sent: true })),
  },
});
```

```typescript
// workflows.ts
import { declareWorkflow, propagateActivityFailure } from "@temporal-contract/worker/workflow";

import { myContract } from "./contract.js";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async ({ activities }, input) => {
    // Every activity call returns an AsyncResult — narrow it, or use
    // `propagateActivityFailure` to let Temporal decide the workflow's fate.
    // A bare `await` here compiles but silently discards a failed call.
    await propagateActivityFailure(activities.sendEmail({ to: "user@example.com", body: "Done!" }));
    return { success: true };
  },
});
```

```typescript
// worker.ts
import { NativeConnection } from "@temporalio/worker";
import { TypedWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";

import { activities } from "./activities.js";
import { myContract } from "./contract.js";

const connection = await NativeConnection.connect({ address: "localhost:7233" });

// The task queue comes from the contract; the workflows path is resolved
// from this module's URL (ESM — include the extension explicitly).
const workerResult = await TypedWorker.create({
  contract: myContract,
  connection,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities,
});
if (workerResult.isDefect()) {
  // Bundling / connection failure — a TechnicalError-caused defect, not thrown.
  console.error("worker setup failed", workerResult.cause);
  process.exit(1);
}

// `run()` returns AsyncResult<void, never> — a runtime failure is a defect
// whose cause `.get()` rethrows. The raw Temporal Worker stays reachable
// via `.raw` (e.g. `worker.raw.runUntil(...)` in tests).
const worker = workerResult.get();
await worker.run().get();
```

### Workflow-only workers

`activities` is optional on `TypedWorker.create`. Omit it to run a worker that only
executes workflows — useful when workflow code and activity code are deployed
and scaled as separate processes on the same task queue:

```typescript
const workerResult = await TypedWorker.create({
  contract: myContract,
  connection,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  // no `activities` — this process polls for Workflow Tasks only
});
```

### Child Workflows

Execute child workflows with type-safe `AsyncResult`. Supports both same-contract and cross-contract child workflows:

```typescript
// workflows.ts
import { declareWorkflow } from "@temporal-contract/worker/workflow";
import { P } from "unthrown";

export const parentWorkflow = declareWorkflow({
  workflowName: "parentWorkflow",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, input) => {
    // Execute child workflow from same contract and wait for result
    const childResult = await context.executeChildWorkflow(myContract, "processPayment", {
      workflowId: `payment-${input.orderId}`,
      args: { amount: input.totalAmount },
    });

    childResult.match({
      ok: (output) => console.log("Payment processed:", output),
      errCases: (matcher) =>
        matcher.with(
          P.tag("@temporal-contract/ChildWorkflowError"),
          P.tag("@temporal-contract/ChildWorkflowCancelledError"),
          P.tag("@temporal-contract/ChildWorkflowNotFoundError"),
          (error) => console.error("Payment failed:", error),
        ),
      defect: (cause) => console.error("Unexpected failure:", cause),
    });

    // Execute child workflow from another contract (another worker)
    const notificationResult = await context.executeChildWorkflow(
      notificationContract,
      "sendNotification",
      {
        workflowId: `notification-${input.orderId}`,
        args: { message: "Order received" },
      },
    );

    // Or start child workflow without waiting
    const handleResult = await context.startChildWorkflow(myContract, "sendEmail", {
      workflowId: `email-${input.orderId}`,
      args: { to: "user@example.com", body: "Order received" },
    });

    handleResult.match({
      ok: async (handle) => {
        // Can wait for result later
        const result = await handle.result();
        // ...
      },
      errCases: (matcher) =>
        matcher.with(
          P.tag("@temporal-contract/ChildWorkflowError"),
          P.tag("@temporal-contract/ChildWorkflowCancelledError"),
          P.tag("@temporal-contract/ChildWorkflowNotFoundError"),
          (error) => console.error("Failed to start:", error),
        ),
      defect: (cause) => console.error("Unexpected failure:", cause),
    });

    return { success: true };
  },
});
```

### Per-activity options

`activityOptions` sets defaults for every activity reachable from the workflow.
To override options for individual activities, add `activityOptionsByName`. Each
entry shallow-merges over the defaults — the override wins on every property it
sets, including the whole nested `retry` block.

The override value is Temporal's full `ActivityOptions`, so `taskQueue` is
available too. That lets you route specific activities to dedicated worker pools
(e.g. a concurrency-capped queue for LLM calls) while the rest of the workflow
stays on the default queue — without dropping to a raw `proxyActivities` call,
which would bypass the Zod input/output validation:

```typescript
export const extractLayout = declareWorkflow({
  workflowName: "extractLayout",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "10 minutes" }, // default for all
  activityOptionsByName: {
    // LLM activity → dedicated, concurrency-capped queue.
    extractLayoutChunk: { taskQueue: "gemini-pro" },
    // Slow payment gateway → longer timeout + aggressive retry.
    chargePayment: {
      startToCloseTimeout: "5 minutes",
      retry: { maximumAttempts: 5 },
    },
    // Activities not listed here fall through to the default queue/options.
  },
  implementation: async ({ activities }, input) => {
    // Each call still validates input/output against the contract, and
    // still returns an AsyncResult — propagate it to let a failure fail
    // the workflow instead of returning an AsyncResult where `{ layout }`
    // expects the unwrapped value.
    const layout = await propagateActivityFailure(
      activities.extractLayoutChunk({ docId: input.docId }),
    );
    return { layout };
  },
});
```

Activity names are typed against the contract (workflow-local + global), so
typos surface as TypeScript errors rather than silently running with defaults.

## Documentation

📖 **[Read the full documentation →](https://btravstack.github.io/temporal-contract)**

- [API Reference](https://btravstack.github.io/temporal-contract/api/worker)
- [Worker surface](https://btravstack.github.io/temporal-contract/reference/worker-surface)
- [Examples](https://btravstack.github.io/temporal-contract/examples/)

## License

MIT
