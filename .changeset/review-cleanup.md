---
"@temporal-contract/contract": patch
"@temporal-contract/worker": patch
"@temporal-contract/client": patch
"@temporal-contract/boxed": patch
"@temporal-contract/testing": patch
---

Review-driven cleanup across packages.

- **`@temporal-contract/worker`**: remove `main`/`module`/`types` fields from `package.json` that pointed to non-existent `dist/index.*` files; the package is consumed via the `./activity`, `./worker`, `./workflow` subpath exports only.
- **`@temporal-contract/contract`**: `defineContract` now also rejects two workflows declaring activities with the same name. Activities live in a single flat namespace at runtime, so duplicates were silently clobbering each other before.
- **`@temporal-contract/client`**: validation error messages (`WorkflowValidationError`, `QueryValidationError`, `SignalValidationError`, `UpdateValidationError`) now join issue messages with `; ` instead of `JSON.stringify`-ing the entire issue array. The `issues` array remains accessible as a typed property.
- **`@temporal-contract/testing`**: import `NativeConnection` from the public `@temporalio/worker` entry point instead of the deep `@temporalio/worker/lib/connection.js` path.
- **`@temporal-contract/worker`**: hoisted the child-workflow helpers out of `declareWorkflow`'s closure to module scope. No behavior change.
