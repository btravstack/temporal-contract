---
"@temporal-contract/contract": minor
"@temporal-contract/worker": minor
"@temporal-contract/client": minor
---

Contract-declared typed domain errors, activity middleware + typed dependency context, and contract-level default activity options.

- **Typed domain errors** — `defineActivity` / `defineWorkflow` accept an `errors` map (`{ data?: StandardSchema, message?, nonRetryable? }` per name). Activity implementations receive typed constructors via a new helpers argument (`(args, { errors }) => Err(errors.PaymentDeclined({ reason }))`); the worker serializes them as `ApplicationFailure` (`type` = error name, `details[0]` = validated payload, `nonRetryable` from the contract). On the workflow side, errors-declaring activities now return `AsyncResult<Output, ContractError union | ActivityError | ActivityCancelledError>` (mirroring the child-workflow API); activities without declared errors keep the throwing `Promise` shape. Workflows can declare their own errors and fail with `throw context.errors.X(data)`; the typed client rehydrates matching failures into `ContractError` on `executeWorkflow` and `handle.result()`. New `@temporal-contract/contract/errors` entry point exports `ContractError` and the supporting types.
- **Activity middleware + typed context** — `declareActivitiesHandler` accepts `createContext` (typed dependency injection, surfaced to implementations as `helpers.context`) and `middleware` (contract-aware chain running inside the validation boundary, operating on the unthrown `AsyncResult`).
- **Contract-level activity option defaults** — `defineActivity` accepts `defaultOptions` (timeouts, retry policy). Merge precedence at the worker: `declareWorkflow` `activityOptions` < contract `defaultOptions` < `activityOptionsByName`.
