/**
 * Named constants for the unthrown `_tag` literals of this package's tagged
 * errors, so consumers can match without hand-writing the namespaced strings
 * (mirrors `@temporal-contract/contract`'s and `@temporal-contract/worker`'s
 * `error-tags.ts`):
 *
 * ```ts
 * result.mapErrCases((matcher) =>
 *   matcher.with(P.tag(WORKFLOW_FAILED_ERROR_TAG), (e) => e.workflowId),
 * );
 * ```
 *
 * Kept in a standalone, dependency-free module (no `unthrown` import) so the
 * constants stay importable without pulling in any runtime machinery.
 */

/** `_tag` of `RuntimeClientError` — generic technical-failure wrapper (rides the defect channel). */
export const RUNTIME_CLIENT_ERROR_TAG = "@temporal-contract/RuntimeClientError";

/** `_tag` of `WorkflowNotInContractError` — the workflow name isn't declared on the bound contract. */
export const WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG = "@temporal-contract/WorkflowNotInContractError";

/** `_tag` of `WorkflowAlreadyStartedError` — starting collided with an existing execution. */
export const WORKFLOW_ALREADY_STARTED_ERROR_TAG = "@temporal-contract/WorkflowAlreadyStartedError";

/** `_tag` of `WorkflowExecutionNotFoundError` — the targeted execution doesn't exist in the namespace. */
export const WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG =
  "@temporal-contract/WorkflowExecutionNotFoundError";

/** `_tag` of `WorkflowFailedError` — the execution completed with a (non-outcome) failure. */
export const WORKFLOW_FAILED_ERROR_TAG = "@temporal-contract/WorkflowFailedError";

/**
 * `_tag` of the client's `WorkflowCancelledError` — the execution ended
 * `Cancelled`. Deliberately the same literal as the worker package's
 * in-workflow `WorkflowCancelledError` tag: both mean "this workflow was
 * cancelled", observed from different sides of the task queue, so grouped
 * matchers treat them alike.
 */
export const WORKFLOW_CANCELLED_ERROR_TAG = "@temporal-contract/WorkflowCancelledError";

/** `_tag` of `WorkflowTerminatedError` — the execution was terminated. */
export const WORKFLOW_TERMINATED_ERROR_TAG = "@temporal-contract/WorkflowTerminatedError";

/** `_tag` of `WorkflowTimeoutError` — the execution timed out. */
export const WORKFLOW_TIMEOUT_ERROR_TAG = "@temporal-contract/WorkflowTimeoutError";

/** `_tag` of `WorkflowValidationError` — workflow input/output failed schema validation. */
export const WORKFLOW_VALIDATION_ERROR_TAG = "@temporal-contract/WorkflowValidationError";

/** `_tag` of `QueryValidationError` — query input/output failed schema validation. */
export const QUERY_VALIDATION_ERROR_TAG = "@temporal-contract/QueryValidationError";

/** `_tag` of `QueryFailedError` — the query could not be served (unregistered handler or handler failure). */
export const QUERY_FAILED_ERROR_TAG = "@temporal-contract/QueryFailedError";

/** `_tag` of `SignalValidationError` — signal input failed schema validation. */
export const SIGNAL_VALIDATION_ERROR_TAG = "@temporal-contract/SignalValidationError";

/** `_tag` of `UpdateValidationError` — update input/output failed schema validation (client side). */
export const UPDATE_VALIDATION_ERROR_TAG = "@temporal-contract/UpdateValidationError";

/** `_tag` of `UpdateFailedError` — the update handler failed after admission. */
export const UPDATE_FAILED_ERROR_TAG = "@temporal-contract/UpdateFailedError";

/** `_tag` of `UpdateRejectedError` — the update was rejected at admission by the worker-side validator. */
export const UPDATE_REJECTED_ERROR_TAG = "@temporal-contract/UpdateRejectedError";

/** `_tag` of `ScheduleAlreadyExistsError` — `schedule.create` collided with a running schedule. */
export const SCHEDULE_ALREADY_EXISTS_ERROR_TAG = "@temporal-contract/ScheduleAlreadyExistsError";

/** `_tag` of `ScheduleNotFoundError` — the schedule ID is unknown to the Temporal server. */
export const SCHEDULE_NOT_FOUND_ERROR_TAG = "@temporal-contract/ScheduleNotFoundError";
