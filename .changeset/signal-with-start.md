---
"@temporal-contract/client": minor
"@temporal-contract/contract": minor
"@temporal-contract/worker": minor
"@temporal-contract/boxed": minor
"@temporal-contract/testing": minor
---

Add `TypedClient#signalWithStart` for the actor-style "send a signal, start the workflow if it doesn't exist" pattern.

Closes #178.

Both halves of the call are typed against the contract: workflow input validates against `contract.workflows[name].input`, signal input validates against `contract.workflows[name].signals[signalName].input`. Returns a `TypedWorkflowHandleWithSignaledRunId` — the standard typed handle plus a `signaledRunId` field for correlating the signal with the (possibly pre-existing) workflow execution chain.

```ts
const result = await client.signalWithStart("processOrder", {
  workflowId: "order-123",
  args: { orderId: "ORD-123", customerId: "CUST-1" },     // typed against workflow input
  signalName: "cancel",                                     // restricted to declared signals
  signalArgs: { reason: "duplicate" },                      // typed against signal input
});

result.match({
  Ok: (handle) => console.log("signaled run", handle.signaledRunId),
  Error: (error) => /* WorkflowNotFoundError | WorkflowValidationError | SignalValidationError | RuntimeClientError */,
});
```
