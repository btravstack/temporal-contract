---
"@temporal-contract/worker": patch
---

Hoist `defineSignal` / `defineQuery` / `defineUpdate` helpers out of `declareWorkflow`'s closure.

Closes #185.

Internal refactor — no behavior change. The three helpers that bind contract-validated signal / query / update handlers to a running workflow are now top-level functions in a new `handlers.ts` module instead of nested closures inside `declareWorkflow`. Their bodies (≈130 LoC) are no longer reallocated on each workflow invocation, and `workflow.ts` shrinks from ~870 to ~720 LoC.

The typed call-site surface is preserved: `context.defineSignal/Query/Update` still carry their `K extends keyof TContract["workflows"][TWorkflowName]["signals" | "queries" | "updates"]` constraints, the runtime guards against missing-block / unknown-name still fire with the same messages, and the query helper still rejects async-validating schemas (Temporal's queries must be synchronous).

Three handler-implementation type aliases (`SignalHandlerImplementation`, `QueryHandlerImplementation`, `UpdateHandlerImplementation`) move alongside the bind helpers since they belong with the handler concept rather than the entry point.
