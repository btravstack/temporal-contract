/**
 * Named constants for the unthrown `_tag` literals of this package's tagged
 * errors, so consumers can match without hand-writing the namespaced strings
 * (mirrors `@temporal-contract/contract`'s `error-tags.ts`):
 *
 * ```ts
 * result.mapErrCases((matcher) =>
 *   matcher.with(P.tag(ACTIVITY_ERROR_TAG), (e) => e.activityName),
 * );
 * ```
 *
 * Kept in a standalone, dependency-free module (no `unthrown` import) so the
 * constants stay importable without pulling in any runtime machinery.
 *
 * Note: the worker's `ValidationError` subclasses (input/output validation,
 * `ContractMisuseError`) are `ApplicationFailure`s, not tagged errors — they
 * are discriminated by `failure.type`, not `_tag`, and have no constant here.
 */

/** `_tag` of `ActivityError` — an activity call failed for a reason other than a declared contract error. */
export const ACTIVITY_ERROR_TAG = "@temporal-contract/ActivityError";

/** `_tag` of `ActivityCancelledError` — a call to an activity was cancelled. */
export const ACTIVITY_CANCELLED_ERROR_TAG = "@temporal-contract/ActivityCancelledError";

/** `_tag` of `ActivityDefinitionNotFoundError` — an implementation was supplied for an undeclared activity. */
export const ACTIVITY_DEFINITION_NOT_FOUND_ERROR_TAG =
  "@temporal-contract/ActivityDefinitionNotFoundError";

/** `_tag` of `ChildWorkflowError` — a child-workflow operation failed. */
export const CHILD_WORKFLOW_ERROR_TAG = "@temporal-contract/ChildWorkflowError";

/** `_tag` of `ChildWorkflowCancelledError` — a child-workflow operation was cancelled. */
export const CHILD_WORKFLOW_CANCELLED_ERROR_TAG = "@temporal-contract/ChildWorkflowCancelledError";

/** `_tag` of `ChildWorkflowNotFoundError` — the child workflow isn't declared on the contract. */
export const CHILD_WORKFLOW_NOT_FOUND_ERROR_TAG = "@temporal-contract/ChildWorkflowNotFoundError";

/** `_tag` of `WorkflowCancelledError` — a typed cancellation scope was cancelled. */
export const WORKFLOW_CANCELLED_ERROR_TAG = "@temporal-contract/WorkflowCancelledError";
