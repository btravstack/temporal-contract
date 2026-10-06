---
"@temporal-contract/worker": major
---

Worker audit hardening — no more silent workflow-task retry loops, typed child errors, and a cleaner dependency graph.

- **Library errors thrown from workflow code fail the workflow.** `throw result.error` / `.getOrThrow()` on an `ActivityError`, `ChildWorkflowError`, `*CancelledError` or `ChildWorkflowNotFoundError` used to retry the workflow task forever; `declareWorkflow`, signal handlers and update handlers now map them to the Temporal failure they carry (the same mapping as `propagateFailure`). A rehydrated activity/child `ContractError` fails with its own `ApplicationFailure` instead of a misleading "not declared on workflow" error. A thrown update-handler error now rejects the update.
- **`context.info` is live.** It is a getter over `workflowInfo()`, so `continueAsNewSuggested` / `historyLength` update between activations.
- **Child workflows follow the contract.** A child whose definition declares `workflowId` gets it derived from the validated `args`, and `options.workflowId` is a type error. A child's declared errors are rehydrated into typed `ContractError`s on `executeChildWorkflow` / `handle.result()` (new `ChildWorkflowContractErrorsOf`), and `context.saga` compensates on them. Migration: drop `workflowId` from child calls to deriving workflows; handle the new `ContractError` members on the error channel.
- **No per-call `workflowIdReusePolicy` on child workflows.** The child's contract `startPolicy` owns it, as on the client; the option is gone from `TypedChildWorkflowOptions`. Migration: change the child's `startPolicy` instead of overriding per call.
- **`ContractMisuseError` for structural misuse.** An undeclared `ContractError` name (was `ContractErrorDataValidationError` with a fake issue), a `continueAsNew` target not on the contract (was `WorkflowInputValidationError`), and `declareActivitiesHandler`'s missing / conflicting / ambiguous implementations (were plain `Error`). `ContractMisuseError` is now also exported from `./activity`. Migration: match on `ContractMisuseError` / `type === "ContractMisuseError"`.
- **`TypedWorker.create` fails on a misdeclared workflows module.** A `ContractMisuseError` (or other worker `ValidationError`) thrown by `declareWorkflow` at import is a `TechnicalError` defect instead of being skipped.
- **`TypedWorker.shutdown()` returns `Result<void, never>`** — calling it on a worker that is not running is a `TechnicalError`-caused defect, not a throw. Migration: `worker.shutdown().get()` to keep throwing.
- **Validation failures carry their issues in `details[0]`** (`{ message, path }`, encrypted by payload codecs) now that `message` lists paths only.
- **No bind-time sync-schema probe.** An async query/update-input schema is rejected on the first query/update by the per-call guard, not when the handler is bound.
- **`qualifyFailure` never wraps a cancellation** (`CancelledFailure`, `AbortError`), even with `expected: "any"` — it rides the defect channel and stays a cancellation.
- **`rethrowCancellation` / `propagateFailure`** throw a fresh `CancelledFailure` when a cancellation error has no `cause`, instead of the stalling tagged error.
- **Scope typing.** `cancellableScope` / `nonCancellableScope` resolve to `Awaited<T>`, matching runtime adoption of a returned `AsyncResult`.
- **`ActivitiesHandler`'s wire-facing input** is the client-side input type (`ClientInferInput`).
- **Rehydration misses are logged** via the workflow logger (`log.warn`, error name and reason only).
- **Dependencies.** `@temporal-contract/contract` is a peer dependency (`^8.0.0-beta.11`); `ContractError` checks are `_tag`-based so a duplicate copy still works. Peer floors: `@temporalio/*` `^1.24.0`, `unthrown` `^5.11.0`. Migration: install `@temporal-contract/contract` alongside the worker and bump the floors.
- The `./activity` entry no longer loads `@temporalio/workflow`; activity middleware lives in its own module (same exports).
