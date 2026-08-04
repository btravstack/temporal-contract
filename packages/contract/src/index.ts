export {
  defineActivity,
  defineContract,
  defineQuery,
  defineSearchAttribute,
  defineSignal,
  defineUpdate,
  defineWorkflow,
} from "./builder.js";

export { formatIssue, summarizeIssues } from "./format.js";

export { CONTRACT_ERROR_TAG, TECHNICAL_ERROR_TAG } from "./error-tags.js";

export type { IdempotencyMode } from "./idempotency.js";

export type {
  AnySchema,
  UndefinedInputSchema,
  ActivityDefinition,
  SignalDefinition,
  QueryDefinition,
  UpdateDefinition,
  WorkflowDefinition,
  AnyWorkflowDefinition,
  ContractDefinition,
  // Typed domain errors
  ErrorDefinition,
  InferDeclaredErrors,
  InferErrorData,
  InferErrorDataInput,
  // Contract-level activity option defaults
  ContractActivityOptions,
  ActivityRetryPolicy,
  DurationValue,
  // Search attributes
  SearchAttributeKind,
  SearchAttributeKindToType,
  SearchAttributeDefinition,
  // Contract utility types
  InferWorkflowNames,
  InferActivityNames,
  // Direction-aware schema inference primitives (shared by worker + client)
  WorkerInferInput,
  WorkerInferOutput,
  ClientInferInput,
  ClientInferOutput,
  InferSignalNames,
  InferQueryNames,
  InferUpdateNames,
} from "./types.js";
