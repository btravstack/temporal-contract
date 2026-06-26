import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { AsyncResult } from "unthrown";
import type {
  AnySchema,
  ActivityDefinition,
  AnyWorkflowDefinition,
  SignalDefinition,
  QueryDefinition,
  UpdateDefinition,
  ContractDefinition,
} from "@temporal-contract/contract";

/**
 * Infer input type from a definition (client perspective)
 * Client sends the input type (before input schema parsing/transformation)
 */
export type ClientInferInput<T extends { input: AnySchema }> = StandardSchemaV1.InferInput<
  T["input"]
>;

/**
 * Infer output type from a definition (client perspective)
 * Client receives the output type (after output schema parsing/transformation)
 */
export type ClientInferOutput<T extends { output: AnySchema }> = StandardSchemaV1.InferOutput<
  T["output"]
>;

/**
 * CLIENT PERSPECTIVE
 * Client sends z.output and receives z.input
 */

/**
 * Infer workflow function signature from client perspective
 * Client sends z.output and receives z.input
 */
export type ClientInferWorkflow<TWorkflow extends AnyWorkflowDefinition> = (
  args: ClientInferInput<TWorkflow>,
) => Promise<ClientInferOutput<TWorkflow>>;

/**
 * Infer activity function signature from client perspective
 * Client sends z.output and receives z.input
 */
export type ClientInferActivity<TActivity extends ActivityDefinition> = (
  args: ClientInferInput<TActivity>,
) => Promise<ClientInferOutput<TActivity>>;

/**
 * Infer signal handler signature from client perspective
 * Client sends z.output and returns AsyncResult<void, Error>
 */
export type ClientInferSignal<TSignal extends SignalDefinition> = (
  args: ClientInferInput<TSignal>,
) => AsyncResult<void, Error>;

/**
 * Infer query handler signature from client perspective
 * Client sends z.output and receives z.input wrapped in AsyncResult<T, Error>
 */
export type ClientInferQuery<TQuery extends QueryDefinition> = (
  args: ClientInferInput<TQuery>,
) => AsyncResult<ClientInferOutput<TQuery>, Error>;

/**
 * Infer update handler signature from client perspective
 * Client sends z.output and receives z.input wrapped in AsyncResult<T, Error>
 */
export type ClientInferUpdate<TUpdate extends UpdateDefinition> = (
  args: ClientInferInput<TUpdate>,
) => AsyncResult<ClientInferOutput<TUpdate>, Error>;

/**
 * CLIENT PERSPECTIVE - Contract-level types
 */

/**
 * Infer all workflows from a contract (client perspective)
 */
export type ClientInferWorkflows<TContract extends ContractDefinition> = {
  [K in keyof TContract["workflows"]]: ClientInferWorkflow<TContract["workflows"][K]>;
};

/**
 * Infer all activities from a contract (client perspective)
 */
export type ClientInferActivities<TContract extends ContractDefinition> =
  TContract["activities"] extends Record<string, ActivityDefinition>
    ? {
        [K in keyof TContract["activities"]]: ClientInferActivity<TContract["activities"][K]>;
      }
    : {};

/**
 * Infer activities from a workflow definition (client perspective)
 */
export type ClientInferWorkflowActivities<T extends AnyWorkflowDefinition> =
  T["activities"] extends Record<string, ActivityDefinition>
    ? {
        [K in keyof T["activities"]]: ClientInferActivity<T["activities"][K]>;
      }
    : {};

/**
 * Infer signals from a workflow definition (client perspective)
 */
export type ClientInferWorkflowSignals<T extends AnyWorkflowDefinition> =
  T["signals"] extends Record<string, SignalDefinition>
    ? {
        [K in keyof T["signals"]]: ClientInferSignal<T["signals"][K]>;
      }
    : {};

/**
 * Infer queries from a workflow definition (client perspective)
 */
export type ClientInferWorkflowQueries<T extends AnyWorkflowDefinition> =
  T["queries"] extends Record<string, QueryDefinition>
    ? {
        [K in keyof T["queries"]]: ClientInferQuery<T["queries"][K]>;
      }
    : {};

/**
 * Infer updates from a workflow definition (client perspective)
 */
export type ClientInferWorkflowUpdates<T extends AnyWorkflowDefinition> =
  T["updates"] extends Record<string, UpdateDefinition>
    ? {
        [K in keyof T["updates"]]: ClientInferUpdate<T["updates"][K]>;
      }
    : {};

/**
 * Infer all activities available in a workflow context (client perspective)
 * Combines workflow-specific activities with global activities
 */
export type ClientInferWorkflowContextActivities<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
> = ClientInferWorkflowActivities<TContract["workflows"][TWorkflowName]> &
  ClientInferActivities<TContract>;
