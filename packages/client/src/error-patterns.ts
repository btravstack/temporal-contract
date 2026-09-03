/**
 * Ready-made pattern groups for the client's error channels, so a caller who
 * wants "handle my domain error, log the rest" does not hand-write the same
 * six `P.tag(...)` arguments at every call site.
 *
 * Each group mirrors **one method's error union exactly**, so spreading it
 * into a `.with(...)` arm covers that union:
 *
 * ```ts
 * import { WORKFLOW_RESULT_PATTERNS } from "@temporal-contract/client";
 *
 * (await handle.result()).match({
 *   ok: (order) => order.orderId,
 *   errCases: (matcher) =>
 *     matcher
 *       .with({ errorName: "PaymentDeclined" }, (err) => err.data.reason)
 *       .with(...WORKFLOW_RESULT_PATTERNS, (err) => logger.error({ err })),
 *   defect: (cause) => logger.error({ cause }),
 * });
 * ```
 *
 * **Exhaustiveness is not weakened.** These are ordinary tuples of ordinary
 * patterns: the matcher still subtracts each one from `Remaining`, and a
 * member missing from an arm is still a compile error naming it
 * (`NonExhaustive<WorkflowTimeoutError>`). Grouping saves typing, not
 * checking.
 *
 * **Contract errors are deliberately excluded.** A workflow's declared
 * `errors` are user-defined, so no shipped group can name them; match them
 * first with the `{ errorName: "..." }` object pattern. For a workflow that
 * declares errors, a `WORKFLOW_RESULT_PATTERNS` arm alone is therefore *not*
 * exhaustive — which is the correct outcome: a declared domain error deserves
 * its own branch.
 *
 * Kept separate from `error-tags.ts`, which stays free of any `unthrown`
 * import so the raw `_tag` constants can be used without pulling in runtime
 * machinery.
 */
import { P } from "unthrown";

import {
  QUERY_FAILED_ERROR_TAG,
  QUERY_VALIDATION_ERROR_TAG,
  SCHEDULE_ALREADY_EXISTS_ERROR_TAG,
  SIGNAL_VALIDATION_ERROR_TAG,
  UPDATE_FAILED_ERROR_TAG,
  UPDATE_REJECTED_ERROR_TAG,
  UPDATE_VALIDATION_ERROR_TAG,
  WORKFLOW_ALREADY_STARTED_ERROR_TAG,
  WORKFLOW_CANCELLED_ERROR_TAG,
  WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG,
  WORKFLOW_FAILED_ERROR_TAG,
  WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG,
  WORKFLOW_TERMINATED_ERROR_TAG,
  WORKFLOW_TIMEOUT_ERROR_TAG,
  WORKFLOW_VALIDATION_ERROR_TAG,
} from "./error-tags.js";

/**
 * Every error `ContractClient.startWorkflow` / `signalWithStart` can produce:
 * the workflow name is not on the contract, its input failed validation, or
 * an execution under this workflow ID already exists.
 */
export const WORKFLOW_START_PATTERNS = [
  P.tag(WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG),
  P.tag(WORKFLOW_VALIDATION_ERROR_TAG),
  P.tag(WORKFLOW_ALREADY_STARTED_ERROR_TAG),
] as const;

/**
 * The non-contract-error tail of `WorkflowResultErrorsOf` — everything
 * `TypedWorkflowHandle.result()` can produce besides the workflow's own
 * declared `errors`: output validation, a generic completion failure, the
 * three first-class stopped outcomes, and a missing execution.
 */
export const WORKFLOW_RESULT_PATTERNS = [
  P.tag(WORKFLOW_VALIDATION_ERROR_TAG),
  P.tag(WORKFLOW_FAILED_ERROR_TAG),
  P.tag(WORKFLOW_CANCELLED_ERROR_TAG),
  P.tag(WORKFLOW_TERMINATED_ERROR_TAG),
  P.tag(WORKFLOW_TIMEOUT_ERROR_TAG),
  P.tag(WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG),
] as const;

/**
 * `ContractClient.executeWorkflow` is start + result, so its union is the
 * widest: both phases, minus the workflow's own declared `errors`.
 */
export const WORKFLOW_EXECUTE_PATTERNS = [
  P.tag(WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG),
  P.tag(WORKFLOW_ALREADY_STARTED_ERROR_TAG),
  P.tag(WORKFLOW_VALIDATION_ERROR_TAG),
  P.tag(WORKFLOW_FAILED_ERROR_TAG),
  P.tag(WORKFLOW_CANCELLED_ERROR_TAG),
  P.tag(WORKFLOW_TERMINATED_ERROR_TAG),
  P.tag(WORKFLOW_TIMEOUT_ERROR_TAG),
  P.tag(WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG),
] as const;

/**
 * The three outcomes that mean "the execution was stopped, and not by
 * completing" — cancelled, terminated, timed out. A subset of
 * {@link WORKFLOW_RESULT_PATTERNS}, for callers that treat those alike but
 * want the remaining failures branched separately.
 */
export const WORKFLOW_STOPPED_PATTERNS = [
  P.tag(WORKFLOW_CANCELLED_ERROR_TAG),
  P.tag(WORKFLOW_TERMINATED_ERROR_TAG),
  P.tag(WORKFLOW_TIMEOUT_ERROR_TAG),
] as const;

/** Every error a `handle.signals.*` call can produce. */
export const SIGNAL_PATTERNS = [
  P.tag(SIGNAL_VALIDATION_ERROR_TAG),
  P.tag(WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG),
] as const;

/** Every error a `handle.queries.*` call can produce. */
export const QUERY_PATTERNS = [
  P.tag(QUERY_VALIDATION_ERROR_TAG),
  P.tag(QUERY_FAILED_ERROR_TAG),
  P.tag(WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG),
] as const;

/** Every error a `handle.updates.*` call can produce. */
export const UPDATE_PATTERNS = [
  P.tag(UPDATE_VALIDATION_ERROR_TAG),
  P.tag(UPDATE_REJECTED_ERROR_TAG),
  P.tag(UPDATE_FAILED_ERROR_TAG),
  P.tag(WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG),
] as const;

/** Every error `schedule.create` can produce. */
export const SCHEDULE_CREATE_PATTERNS = [
  P.tag(SCHEDULE_ALREADY_EXISTS_ERROR_TAG),
  P.tag(WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG),
  P.tag(WORKFLOW_VALIDATION_ERROR_TAG),
] as const;
