---
"@temporal-contract/worker": minor
"@temporal-contract/contract": minor
"@temporal-contract/client": minor
"@temporal-contract/boxed": minor
"@temporal-contract/testing": minor
---

Add typed `context.continueAsNew(...)` to the workflow context.

Closes #179.

Two overloads:

```ts
// Same workflow — args validated against this workflow's input schema
return context.continueAsNew({ ...args, retryCount: args.retryCount + 1 });

// Cross-contract — workflowType and taskQueue come from the destination
// contract automatically; args validated against the destination's input
return context.continueAsNew(otherContract, "otherWorkflow", { ...newArgs });
```

Both validate args via the same Standard Schema check `declareWorkflow` runs on incoming inputs. On validation failure, throws `WorkflowInputValidationError`, which surfaces back to Temporal as a controlled workflow failure rather than silently proceeding with an invalid run.

Both forms also accept a third optional argument matching Temporal's `ContinueAsNewOptions` minus `workflowType` / `taskQueue` (those come from the contract). The user options are spread last so power users can override fields like `workflowRunTimeout`, `memo`, or `retry`.

Returns `Promise<never>` — Temporal's `continueAsNew` throws an internal exception that the runtime intercepts to terminate the current execution and start a new one.
