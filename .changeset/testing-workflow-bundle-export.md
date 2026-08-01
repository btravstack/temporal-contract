---
"@temporal-contract/testing": minor
---

New `@temporal-contract/testing/workflow-bundle` subpath: `bundleFor` (memoizes a `bundleWorkflowCode` call per `workflowsPath` within a test file), `withTaskQueue` (scopes a contract to a per-test task queue), `nextTaskQueueId` (a reproducible, non-random monotonic id generator), and `fixturePath` (resolves a sibling fixture file relative to the caller's `import.meta.url`, working from both `.ts` source and built output). Backs the mock-free `*.inprocess.spec.ts` test tier and is now the shared home for a path-resolution helper that was previously copy-pasted into every one of those spec files.
