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
export type {
  ClientCallError,
  ClientInterceptor,
  ClientInterceptorArgs,
  ClientInterceptorNext,
} from "./interceptors.js";
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
  tagPatterns,
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
export type { TagPatterns, TemporalFailure } from "./errors.js";
// `_tag` literal constants + grouped bundles for the recurring match
// unions — see `error-tags.ts` and the `tagPatterns` helper above.
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
  WORKFLOW_OUTCOME_ERROR_TAGS,
  WORKFLOW_RESULT_ERROR_TAGS,
  WORKFLOW_START_ERROR_TAGS,
  WORKFLOW_TERMINATED_ERROR_TAG,
  WORKFLOW_TIMEOUT_ERROR_TAG,
  WORKFLOW_VALIDATION_ERROR_TAG,
} from "./error-tags.js";
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
