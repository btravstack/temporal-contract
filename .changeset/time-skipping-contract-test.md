---
"@temporal-contract/testing": minor
---

`createTimeSkippingContractTest({ contract, workflowsPath, activities })` — the
one-call fixture for the **time-skipping** tier, the Docker-free counterpart to
`createContractTest`. It owns the `TestWorkflowEnvironment`, the workflow bundle
(built once per Vitest worker process), the worker, the `TypedClient` binding,
and the replay-on-finish check, and hands the test `{ worker, client }`.

Previously the tier with the better ergonomics was also the one that needed
Docker: the time-skipping tier only offered `testRig`, which makes the caller
build a bundle and manage the environment. `testRig` stays as the lower-level
seam.
