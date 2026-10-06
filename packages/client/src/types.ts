import type {
  SignalDefinition,
  QueryDefinition,
  UpdateDefinition,
  AnyWorkflowDefinition,
  ErrorDefinition,
  SearchAttributeDefinition,
  SearchAttributeKindToType,
} from "@temporal-contract/contract";
import type { ContractErrorUnion } from "@temporal-contract/contract/errors";
import type { AsyncResult } from "unthrown";

import type {
  QueryFailedError,
  QueryValidationError,
  SignalValidationError,
  UpdateFailedError,
  UpdateRejectedError,
  UpdateRpcTimeoutOrCancelledError,
  UpdateValidationError,
  WorkflowCancelledError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
  WorkflowTerminatedError,
  WorkflowTimeoutError,
  WorkflowValidationError,
} from "./errors.js";

// The direction-aware schema inference primitives live in
// `@temporal-contract/contract` (single source of truth shared with the
// worker package); re-exported so the client's public type surface is
// unchanged.
export type { ClientInferInput, ClientInferOutput } from "@temporal-contract/contract";
import type { ClientInferInput, ClientInferOutput } from "@temporal-contract/contract";

/**
 * CLIENT PERSPECTIVE
 *
 * The client sits on the *sending* side of the input boundary and the
 * *receiving* side of the output boundary: it sends a schema's input type
 * (`z.input`, pre-transform — the worker parses on receive) and receives
 * the output type (`z.output`, post-transform — the client parses results
 * on receive).
 */

/**
 * Infer signal handler signature from client perspective.
 * Client sends the signal input type; the payload argument is omittable
 * when the schema accepts `undefined` (e.g. payload-less `defineSignal()`).
 * The error union names exactly what the handle's signal proxy produces:
 * input-validation failure or a missing execution.
 */
export type ClientInferSignal<TSignal extends SignalDefinition> = (
  ...args: undefined extends ClientInferInput<TSignal>
    ? [input?: ClientInferInput<TSignal>]
    : [input: ClientInferInput<TSignal>]
) => AsyncResult<void, SignalValidationError | WorkflowExecutionNotFoundError>;

/**
 * Infer query handler signature from client perspective.
 * Client sends the query input type and receives the output type wrapped in
 * an `AsyncResult`; the payload argument is omittable when the schema
 * accepts `undefined` (e.g. argument-less `defineQuery({ output })`).
 * The error union names exactly what the handle's query proxy produces:
 * input/output-validation failure, a query the execution could not serve
 * (unregistered handler or a throwing handler — `QueryFailedError`), or a
 * missing execution.
 */
export type ClientInferQuery<TQuery extends QueryDefinition> = (
  ...args: undefined extends ClientInferInput<TQuery>
    ? [input?: ClientInferInput<TQuery>]
    : [input: ClientInferInput<TQuery>]
) => AsyncResult<
  ClientInferOutput<TQuery>,
  QueryValidationError | QueryFailedError | WorkflowExecutionNotFoundError
>;

/**
 * Per-call options of an update proxy call — the second argument of
 * `handle.updates.*`.
 */
type UpdateCallOptions = {
  /**
   * Unique ID for this update request (passthrough of Temporal's
   * `updateId`). Meaningful business IDs enable deduplication, and let a
   * caller reattach with `handle.getUpdateHandle(name, updateId)`.
   */
  readonly updateId?: string;
};

/**
 * Infer update handler signature from client perspective.
 * Client sends the update input type and receives the output type wrapped in
 * an `AsyncResult`; the payload argument is omittable when the schema
 * accepts `undefined` (e.g. argument-less `defineUpdate({ output })`), and an
 * optional second argument carries the `updateId`.
 * The error union names exactly what the handle's update proxy produces:
 * input/output-validation failure, a worker-side admission rejection
 * (`UpdateRejectedError`), a failed admitted handler (`UpdateFailedError`),
 * a timed-out or cancelled update call, or a missing execution.
 */
export type ClientInferUpdate<TUpdate extends UpdateDefinition> = (
  ...args: undefined extends ClientInferInput<TUpdate>
    ? [input?: ClientInferInput<TUpdate>, options?: UpdateCallOptions]
    : [input: ClientInferInput<TUpdate>, options?: UpdateCallOptions]
) => AsyncResult<
  ClientInferOutput<TUpdate>,
  | UpdateValidationError
  | UpdateRejectedError
  | UpdateFailedError
  | UpdateRpcTimeoutOrCancelledError
  | WorkflowExecutionNotFoundError
>;

/**
 * Infer signals from a workflow definition (client perspective)
 */
export type ClientInferWorkflowSignals<T extends AnyWorkflowDefinition> =
  T["signals"] extends Record<string, SignalDefinition>
    ? {
        [K in keyof T["signals"]]: ClientInferSignal<T["signals"][K]>;
      }
    : Record<never, never>;

/**
 * Infer queries from a workflow definition (client perspective)
 */
export type ClientInferWorkflowQueries<T extends AnyWorkflowDefinition> =
  T["queries"] extends Record<string, QueryDefinition>
    ? {
        [K in keyof T["queries"]]: ClientInferQuery<T["queries"][K]>;
      }
    : Record<never, never>;

/**
 * Infer updates from a workflow definition (client perspective)
 */
export type ClientInferWorkflowUpdates<T extends AnyWorkflowDefinition> =
  T["updates"] extends Record<string, UpdateDefinition>
    ? {
        [K in keyof T["updates"]]: ClientInferUpdate<T["updates"][K]>;
      }
    : Record<never, never>;

/**
 * Union of typed {@link ContractError}s declared on a workflow's `errors`
 * map, or `never` when the workflow declares none — in which case the member
 * simply vanishes from the surfaced error union.
 *
 * Surfaced by `executeWorkflow` and `handle.result()` when the execution
 * failed with a matching `ApplicationFailure` (`type` = declared error name,
 * `details[0]` validating against the declared `data` schema).
 */
export type WorkflowContractErrorsOf<TWorkflow extends AnyWorkflowDefinition> = TWorkflow extends {
  errors: infer TErrors extends Record<string, ErrorDefinition>;
}
  ? ContractErrorUnion<TErrors>
  : never;

/**
 * Union of the modeled errors a result-awaiting call can surface for a
 * workflow — the shared tail of `executeWorkflow` and `handle.result()`: any
 * contract error declared on the workflow, plus output validation, the
 * generic completion failure, the three first-class workflow outcomes
 * (cancelled / terminated / timed out), and a missing execution.
 */
export type WorkflowResultErrorsOf<TWorkflow extends AnyWorkflowDefinition> =
  | WorkflowContractErrorsOf<TWorkflow>
  | WorkflowValidationError
  | WorkflowFailedError
  | WorkflowCancelledError
  | WorkflowTerminatedError
  | WorkflowTimeoutError
  | WorkflowExecutionNotFoundError;

/**
 * Typed `searchAttributes` map for a workflow, derived from the workflow's
 * declared `searchAttributes`. Each key is constrained to a declared
 * attribute name; each value's type is determined by the attribute's `kind`
 * (e.g. `KEYWORD` → `string`, `INT` → `number`, `DATETIME` → `Date`,
 * `KEYWORD_LIST` → `string[]`).
 *
 * If the workflow declares no search attributes, this resolves to `never`,
 * meaning the `searchAttributes` field is effectively absent from the start
 * options for that workflow.
 */
export type TypedSearchAttributeMap<TWorkflow extends AnyWorkflowDefinition> =
  TWorkflow["searchAttributes"] extends Record<string, SearchAttributeDefinition>
    ? {
        [K in keyof TWorkflow["searchAttributes"]]?: SearchAttributeKindToType<
          TWorkflow["searchAttributes"][K]["kind"]
        >;
      }
    : never;
