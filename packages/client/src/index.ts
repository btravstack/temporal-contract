export {
  ContractClient,
  readTypedSearchAttributes,
  TypedClient,
  type CreateTypedClientOptions,
  type TypedGetHandleOptions,
  type TypedSearchAttributeMap,
  type TypedSignalWithStartOptions,
  type TypedStartUpdateOptions,
  type TypedWorkflowHandle,
  type TypedWorkflowHandleWithSignaledRunId,
  type TypedWorkflowStartOptions,
  type TypedWorkflowUpdateHandle,
  type WorkflowContractErrorsOf,
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
  RuntimeClientError,
  ScheduleAlreadyExistsError,
  ScheduleNotFoundError,
  WorkflowAlreadyStartedError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
  WorkflowNotInContractError,
  WorkflowValidationError,
  QueryValidationError,
  SignalValidationError,
  UpdateValidationError,
} from "./errors.js";
export type { TemporalFailure } from "./errors.js";
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
