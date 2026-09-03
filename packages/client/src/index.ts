export {
  ContractClient,
  readTypedSearchAttributes,
  TypedClient,
  type CreateClientOptions,
  type TypedGetHandleOptions,
  type TypedSearchAttributeMap,
  type TypedSignalWithStartOptions,
  type TypedStartUpdateOptions,
  type TypedWorkflowHandle,
  type TypedWorkflowHandleWithSignaledRunId,
  type TypedWorkflowStartOptions,
  type TypedWorkflowUpdateHandle,
  type WorkflowContractErrorsOf,
  type WorkflowResultErrorsOf,
} from "./client.js";
// Technical creation failure — `TypedClient.create` routes it to the Defect
// channel (as the defect's cause) instead of throwing.
export { TechnicalError } from "@temporal-contract/contract/errors";
// Typed contract-error surface — a failed execution whose failure matches a
// workflow's declared `errors` entry surfaces as a `ContractError` instead
// of the generic `WorkflowFailedError`.
export {
  ContractError,
  type AnyContractError,
  type ContractErrorUnion,
} from "@temporal-contract/contract/errors";
export {
  TypedScheduleClient,
  type TypedScheduleActionOverrides,
  type TypedScheduleCreateOptions,
  type TypedScheduleHandle,
} from "./schedule.js";
export {
  QueryFailedError,
  QueryValidationError,
  RuntimeClientError,
  ScheduleAlreadyExistsError,
  ScheduleNotFoundError,
  SignalValidationError,
  UpdateFailedError,
  UpdateRejectedError,
  UpdateValidationError,
  WorkflowAlreadyStartedError,
  WorkflowCancelledError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
  WorkflowNotInContractError,
  WorkflowTerminatedError,
  WorkflowTimeoutError,
  WorkflowValidationError,
} from "./errors.js";
export type { TemporalFailure } from "./errors.js";
// `_tag` literal constants for matching — see `error-tags.ts`.
export {
  QUERY_FAILED_ERROR_TAG,
  QUERY_VALIDATION_ERROR_TAG,
  RUNTIME_CLIENT_ERROR_TAG,
  SCHEDULE_ALREADY_EXISTS_ERROR_TAG,
  SCHEDULE_NOT_FOUND_ERROR_TAG,
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
// Ready-made pattern groups over those tags, each mirroring one method's
// error union — `matcher.with(...WORKFLOW_RESULT_PATTERNS, handler)` instead
// of six hand-written `P.tag(...)` arguments. Exhaustiveness is unchanged.
export {
  QUERY_PATTERNS,
  SCHEDULE_CREATE_PATTERNS,
  SIGNAL_PATTERNS,
  UPDATE_PATTERNS,
  WORKFLOW_EXECUTE_PATTERNS,
  WORKFLOW_RESULT_PATTERNS,
  WORKFLOW_START_PATTERNS,
  WORKFLOW_STOPPED_PATTERNS,
} from "./error-patterns.js";
export type {
  ClientInferInput,
  ClientInferOutput,
  ClientInferSignal,
  ClientInferQuery,
  ClientInferUpdate,
  ClientInferWorkflowSignals,
  ClientInferWorkflowQueries,
  ClientInferWorkflowUpdates,
} from "./types.js";
