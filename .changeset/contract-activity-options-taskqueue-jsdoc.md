---
"@temporal-contract/contract": patch
---

Clarify why `ContractActivityOptions` excludes `taskQueue`: the reason is that no worker built from the contract would poll a per-activity queue, not that queue names are deployment-specific. The JSDoc now points to the supported routing pattern: an `activityOptionsByName` override plus an activity-only contract on the dedicated queue.
