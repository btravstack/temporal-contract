---
"@temporal-contract/contract": minor
"@temporal-contract/client": patch
"@temporal-contract/worker": patch
"@temporal-contract/testing": patch
---

Expose `formatIssue` and `summarizeIssues` from `@temporal-contract/contract`. Both helpers were previously duplicated between the `client` and `worker` packages (and explicitly hand-synced) — they now live in the contract package as the single source of truth.

Internal: split `packages/worker/src/workflow.ts` (1019 lines) into focused modules — `child-workflow.ts` (child-workflow types + start/execute helpers) and `activities-proxy.ts` (validated-activities proxy + activity inference types). Public API of the worker package is unchanged. Also extract a `resolveDefinitionAndValidateInput` helper in the client package, used by `startWorkflow` / `signalWithStart` / `executeWorkflow` to share the contract-lookup → input-validation → search-attribute-translation ritual.
