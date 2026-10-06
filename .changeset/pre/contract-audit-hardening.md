---
"@temporal-contract/contract": major
---

Contract audit hardening — `defineContract` rejects more invalid contracts up front, and validation messages no longer leak payload values into Temporal history.

- **Validation messages are redacted.** `summarizeIssues` (and so every client/worker validation error `message`, which becomes `ApplicationFailure.message` in history, unencrypted by codecs) lists only issue paths, capped at five (`at email; at items[0].qty; …and 3 more`, `at root` for the value itself) — schema messages embed raw input values. Migration: read `error.issues` for the full detail; update any assertion on the old `at path: message` text.
- **`ContractDefinitionError`.** Definition-validation failures throw this exported `Error` subclass with a dotted `path` (`workflows.processOrder.signals.cancel`); messages read `Contract validation failed at <path>: …`. Migration: match on `instanceof ContractDefinitionError` / `path` instead of the old message text.
- **Strict keys on every definition.** Workflow, activity, signal, query, update, error, and search-attribute definitions reject unknown keys (at runtime, and at compile time on `defineActivity` / `defineWorkflow` / `defineSignal` / `defineQuery` / `defineUpdate`). A leftover `defaultOptions` or `idempotency` gets a rename hint; `workflowId` and `idempotencyKey` must be functions. Migration: remove or rename the stray keys.
- **`startPolicy` is required at runtime**, not just by type. Migration: add it to any workflow assembled outside the type system.
- **Retry policies are validated like Temporal does** (`compileRetryPolicy` plus the server's coefficient floor): `backoffCoefficient < 1`, `maximumAttempts` not a positive integer (`Infinity` stays allowed), a zero interval, or `maximumInterval` below `initialInterval` (1s when unset) now fail at `defineContract` instead of failing the workflow task. Migration: fix the policy the error points at.
- **More reserved names.** `Object.prototype` members (`constructor`, `toString`, …) are rejected as any name; worker failure types (`WorkflowInputValidationError`, `ContractMisuseError`, …) as error names; Temporal system attributes (`WorkflowId`, `ExecutionStatus`, …) as search-attribute names; and one search attribute declared with two different kinds across workflows. Migration: rename.
- **`taskQueue`** may not have leading/trailing whitespace or exceed 1000 characters. Migration: trim it.
- **`onRehydrationMiss` is removed** from `@temporal-contract/contract/errors` — its module-level handler never fired inside the bundled workflow sandbox. Rehydration misses are logged by the worker through the workflow logger instead; the `RehydrationMiss` type stays exported. Migration: delete the registration and watch the worker's `log.warn` output.
- **`IdempotencyMode` is removed**; `WorkflowStartPolicy` is now exported from the package root. Migration: `IdempotencyMode` → `WorkflowStartPolicy`.
