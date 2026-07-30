---
"@temporal-contract/client": patch
---

The exported `ClientInferSignal` / `ClientInferQuery` / `ClientInferUpdate` aliases now carry the concrete error unions the handle proxies actually produce (`{Signal,Query,Update}ValidationError | WorkflowExecutionNotFoundError`) instead of a bare, unmatchable `Error` channel — surfaced by adopting `@unthrown/oxlint`'s `no-ambiguous-error-type` rule. `TypedWorkflowHandle` behavior is unchanged (it already substituted the concrete unions); only direct consumers of the aliases see the more precise types. The rest of the adoption (all six rules at `error`, reasoned `no-throw` disables at the sanctioned throw sites) is comment-and-config only.
