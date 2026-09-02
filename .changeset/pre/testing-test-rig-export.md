---
"@temporal-contract/testing": minor
---

New `@temporal-contract/testing/test-rig` subpath: `testRig` builds the `TypedWorker` + `TypedClient` pair an in-process test needs against a `TestWorkflowEnvironment`, and registers an `onTestFinished` hook that replays every execution the client started — real replay-determinism coverage per test, with no separate replay pass to remember. Options include `replaySkipAllowlist`, a caller-supplied map of workflow-ID prefixes (with reasons) to skip when their execution is deliberately left non-terminal; it defaults to `{}` so a published rig never bakes in this repo's own fixture IDs. Also exports `isTerminalStatus`, `skipReasonFor`, and `extractStartedWorkflowId` for unit-testing the rig's own assumptions.
