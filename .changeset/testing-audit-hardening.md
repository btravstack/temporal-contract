---
"@temporal-contract/testing": major
---

Testing audit hardening — fixtures that isolate parallel files, tear down from any worker state, and fail where production fails.

- **`createContractTest` runs each test file in its own Temporal namespace**, registered on the testcontainers server and used by both the worker and the clients, so parallel files polling the contract's real task queue no longer steal each other's tasks. The new `namespace` fixture names it. A `workerOptions.namespace` replaces it (and must already exist). The workflows are bundled once per file (`workflowBundle`) instead of per test; `workerOptions` no longer accepts `workflowBundle`.
- **`testRig` / `createTimeSkippingContractTest` support workflows whose contract derives the workflow ID** (resolved with `workflowIdFor` for replay) and record `executeUpdateWithStart` starts.
- **Teardown waits for a stopped worker from any state** (`STOPPING` / `DRAINING` / `DRAINED` included) with an explicit timeout, and checks `TypedWorker.shutdown()`'s result.
- **`runActivityHandler` round-trips the input, the output and the failure details through the payload converter** (`defaultPayloadConverter`, or the new `payloadConverter` option), so a value that does not survive serialization — a `Date` under the JSON converter — fails as in production with `ActivityOutputValidationError`. An undeclared error name now surfaces `ContractMisuseError`.
- **`RunActivityImplementation`'s helpers are the worker's `ActivityImplementationHelpers`**, so `idempotencyKey` can be destructured.
- **Global setup:** a container that fails to start stops the ones already started; health-check retries default to 60 and are configurable (`healthCheckRetries`); the default images are pinned by digest; Postgres gets a random password per run and no host port; the Temporal health check uses the `temporal` CLI instead of the end-of-life `tctl`.
- **Internal helpers left the public entries:** `resolveTemporalAddress` (`/extension`) and `isTerminalStatus`, `START_METHODS`, `skipReasonFor`, `extractStartedWorkflowId` (`/test-rig`) are no longer exported.
- **Peers:** `@temporalio/*` floors rise to `^1.24.0` and `unthrown` to `^5.11.0`; `vitest` and `@temporalio/testing` are optional (`/activity` and `/workflow-bundle` need no `vitest`; only `/activity`, `/time-skipping` and `/test-rig` need `@temporalio/testing`). Migration: bump the floors.
