import type {
  SignalDefinition,
  QueryDefinition,
  UpdateDefinition,
  AnyWorkflowDefinition,
} from "@temporal-contract/contract";
import type { AsyncResult } from "unthrown";

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
 */
export type ClientInferSignal<TSignal extends SignalDefinition> = (
  ...args: undefined extends ClientInferInput<TSignal>
    ? [input?: ClientInferInput<TSignal>]
    : [input: ClientInferInput<TSignal>]
) => AsyncResult<void, Error>;

/**
 * Infer query handler signature from client perspective.
 * Client sends the query input type and receives the output type wrapped in
 * `AsyncResult<T, Error>`; the payload argument is omittable when the schema
 * accepts `undefined` (e.g. argument-less `defineQuery({ output })`).
 */
export type ClientInferQuery<TQuery extends QueryDefinition> = (
  ...args: undefined extends ClientInferInput<TQuery>
    ? [input?: ClientInferInput<TQuery>]
    : [input: ClientInferInput<TQuery>]
) => AsyncResult<ClientInferOutput<TQuery>, Error>;

/**
 * Infer update handler signature from client perspective.
 * Client sends the update input type and receives the output type wrapped in
 * `AsyncResult<T, Error>`; the payload argument is omittable when the schema
 * accepts `undefined` (e.g. argument-less `defineUpdate({ output })`).
 */
export type ClientInferUpdate<TUpdate extends UpdateDefinition> = (
  ...args: undefined extends ClientInferInput<TUpdate>
    ? [input?: ClientInferInput<TUpdate>]
    : [input: ClientInferInput<TUpdate>]
) => AsyncResult<ClientInferOutput<TUpdate>, Error>;

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
