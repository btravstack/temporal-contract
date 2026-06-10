---
"@temporal-contract/worker": patch
---

Surface the contract's workflow name on the function returned by `declareWorkflow` (previously anonymous). Temporal's `client.workflow.start(fn, …)` reads `fn.name` to derive the workflow type, so callers who passed the declaration by reference — typically tests sidestepping the typed client — hit an empty workflow type. The typed-client and `workflowsPath` paths were unaffected because they resolve workflows by string name.
