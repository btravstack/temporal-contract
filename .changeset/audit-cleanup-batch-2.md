---
"@temporal-contract/sample-order-processing-contract": patch
"@temporal-contract/sample-order-processing-worker": patch
"@temporal-contract/worker": patch
"@temporal-contract/client": patch
"@temporal-contract/contract": patch
"@temporal-contract/testing": patch
---

Closes the remaining audit items: documents the activity input/output shape asymmetry, replaces the example `log` Temporal activity with `@temporalio/workflow`'s `log` namespace, and converts test assertions from `expect.objectContaining({ name: "...Error" })` to `toBeInstanceOf(...)` across worker / client / example specs.

**Audit #15 — example `log` Temporal activity is a footgun.** Calling an activity per log line balloons workflow history, costs money on Temporal Cloud, and replays on every recovery. The example contract no longer declares a `log` activity; the example workflow imports `log` from `@temporalio/workflow` (replay-safe, routed through the worker's configured logger sink) and calls `log.info(...)` / `log.error(...)` / `log.warn(...)` directly. Domain effects still go through activities. Removed the unused `inventoryReservationId` variable while in there.

**Audit #16 — test assertions on internal shape rather than error class.** Eight sites across `worker/__tests__/worker.spec.ts`, `worker/activity.spec.ts`, `worker/continue-as-new.spec.ts`, `client/__tests__/client.spec.ts`, and the order-processing example's `integration.spec.ts` were asserting on `name: "...Error"` strings instead of the actual error classes. Switched to `toBeInstanceOf(...)`, which catches subclass renames at compile time and matches the contract-not-implementation rule the codebase aspires to.

**Audit #10 — activity input/output shape asymmetry.** Documented in the JSDoc on `ContractResultActivitiesImplementations` and `ActivitiesHandler`. The asymmetry is intentional and worth keeping: the input you write mirrors the contract's structure (global at root + workflow-local nested under their owning workflow), giving IDE autocomplete that matches `defineContract`; the output is flat because Temporal's worker sees a single namespace at runtime. `defineContract` already enforces no-collisions across global+workflow scopes, so the flat output has no ambiguity.
