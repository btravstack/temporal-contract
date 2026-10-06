import type {
  AnyWorkflowDefinition,
  ContractDefinition,
  InferSignalNames,
  InferUpdateNames,
  SignalDefinition,
  UpdateDefinition,
} from "@temporal-contract/contract";
import type { RehydrationMiss } from "@temporal-contract/contract/errors";
import type {
  Client,
  GetWorkflowHandleOptions,
  WorkflowIdConflictPolicy,
  WorkflowStartOptions,
} from "@temporalio/client";

import type { ClientInferInput, TypedSearchAttributeMap } from "./types.js";

/**
 * Options for {@link TypedClient.create} — the single options-object shape
 * shared by the org's `Typed*.create()` factories.
 */
export type CreateClientOptions = {
  /** The underlying `@temporalio/client` `Client`. */
  client: Client;
  /**
   * Called when a failure whose `type` names a declared contract error does
   * NOT rehydrate into it (its payload fails the declared schema, or a
   * data-less error lacks the wire marker) and degrades to the generic
   * `WorkflowFailedError` — a signal of schema drift between client and
   * worker, or of a foreign failure reusing a declared name. A throwing hook
   * is swallowed. Library packages don't log; wire your own here.
   */
  onRehydrationMiss?: (miss: RehydrationMiss) => void;
};

/**
 * The start-option fields the contract owns: the task queue, the payload
 * (typed separately), search attributes (typed separately), the workflow ID
 * (typed by {@link WorkflowIdField}), the reuse policy (the contract's
 * `startPolicy`), and `followRuns` (always followed, so a continued-as-new
 * execution resolves to its final result instead of an unmodeled error).
 */
type ContractOwnedStartFields =
  | "taskQueue"
  | "args"
  | "searchAttributes"
  | "typedSearchAttributes"
  | "workflowId"
  | "workflowIdReusePolicy"
  | "followRuns";

/**
 * The `args` field of the start-shaped options, typed against the
 * workflow's input schema. When the schema accepts `undefined`, the field
 * becomes omittable so input-less workflows don't need `args: undefined`
 * ceremony.
 */
export type WorkflowArgsField<TWorkflow extends AnyWorkflowDefinition> =
  undefined extends ClientInferInput<TWorkflow>
    ? { args?: ClientInferInput<TWorkflow> }
    : { args: ClientInferInput<TWorkflow> };

type WorkflowIdField<TWorkflow extends AnyWorkflowDefinition> = TWorkflow["workflowId"] extends (
  input: never,
) => string
  ? {
      /**
       * Derived from the payload by the contract — passing one here is a
       * type error, because a caller-supplied ID is exactly what defeats a
       * `startPolicy` of `"once-per-id"`.
       */
      readonly workflowId?: never;
    }
  : { readonly workflowId: string };

/** Names of the contract's workflows that derive their workflow ID. */
export type DerivedIdWorkflowName<TContract extends ContractDefinition> = {
  [K in keyof TContract["workflows"] & string]: TContract["workflows"][K]["workflowId"] extends (
    input: never,
  ) => string
    ? K
    : never;
}[keyof TContract["workflows"] & string];

export type TypedWorkflowStartOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
> = Omit<WorkflowStartOptions, ContractOwnedStartFields> &
  WorkflowIdField<TContract["workflows"][TWorkflowName]> &
  WorkflowArgsField<TContract["workflows"][TWorkflowName]> & {
    /**
     * Indexed search attributes for the started workflow. Keys and value types
     * are constrained to those declared on the workflow's contract via
     * `defineSearchAttribute`. Translated to Temporal's `typedSearchAttributes`
     * before the start request is dispatched.
     */
    searchAttributes?: TypedSearchAttributeMap<TContract["workflows"][TWorkflowName]>;
  };

/**
 * The `signalArgs` field of `signalWithStart`'s options, typed against the
 * named signal's input schema. When the schema accepts `undefined` (e.g. a
 * payload-less `defineSignal()`), the field becomes omittable.
 */
type SignalArgsField<TSignalDef> = TSignalDef extends SignalDefinition
  ? undefined extends ClientInferInput<TSignalDef>
    ? { signalArgs?: ClientInferInput<TSignalDef> }
    : { signalArgs: ClientInferInput<TSignalDef> }
  : { signalArgs?: never };

/**
 * Options for {@link ContractClient.signalWithStart} — the start options of
 * {@link TypedWorkflowStartOptions} plus the signal, typed against the named
 * signal's input schema. The signal is addressed by the `signalName` field
 * of this options bag (there is no positional signal parameter), keeping the
 * method at two positional arguments like the rest of the surface.
 */
export type TypedSignalWithStartOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
  TSignalName extends InferSignalNames<TContract["workflows"][TWorkflowName]>,
> = TypedWorkflowStartOptions<TContract, TWorkflowName> &
  SignalArgsField<TContract["workflows"][TWorkflowName]["signals"][TSignalName]> & {
    signalName: TSignalName;
  };

/**
 * The `updateArgs` field of `executeUpdateWithStart`'s options, typed
 * against the named update's input schema; omittable when the schema
 * accepts `undefined`.
 */
type UpdateArgsField<TUpdateDef> = TUpdateDef extends UpdateDefinition
  ? undefined extends ClientInferInput<TUpdateDef>
    ? { updateArgs?: ClientInferInput<TUpdateDef> }
    : { updateArgs: ClientInferInput<TUpdateDef> }
  : { updateArgs?: never };

/**
 * Options for {@link ContractClient.executeUpdateWithStart} — the start
 * options of {@link TypedWorkflowStartOptions} (with the
 * `workflowIdConflictPolicy` Temporal requires for update-with-start) plus
 * the update, addressed by `updateName` like `signalWithStart`'s signal.
 */
export type TypedUpdateWithStartOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
  TUpdateName extends InferUpdateNames<TContract["workflows"][TWorkflowName]>,
> = TypedWorkflowStartOptions<TContract, TWorkflowName> &
  UpdateArgsField<TContract["workflows"][TWorkflowName]["updates"][TUpdateName]> & {
    /**
     * What to do when an execution with this workflow ID is already running:
     * `"USE_EXISTING"` sends the update to it, `"FAIL"` surfaces
     * `WorkflowAlreadyStartedError`. Required by Temporal for
     * update-with-start.
     */
    workflowIdConflictPolicy: WorkflowIdConflictPolicy;
    updateName: TUpdateName;
    /** Unique ID for this update request (passthrough of Temporal's `updateId`). */
    updateId?: string;
  };

/**
 * Options for {@link ContractClient.getHandle}. Temporal's
 * `GetWorkflowHandleOptions` (`firstExecutionRunId` — the chain interlock
 * ensuring mutating methods don't cross into another execution chain) with
 * the optional `runId` of the specific execution to bind. `followRuns` is
 * not offered: the handle always follows the run chain, so `result()` never
 * meets Temporal's unmodeled `WorkflowContinuedAsNewError`.
 */
export type TypedGetHandleOptions = Omit<GetWorkflowHandleOptions, "followRuns"> & {
  /**
   * Run ID of the specific execution to bind the handle to. Omitted, the
   * handle addresses the latest execution of the workflow ID.
   */
  runId?: string;
};

/**
 * Options for {@link TypedWorkflowHandle.startUpdate} — the update payload
 * plus the passthrough subset of Temporal's `WorkflowUpdateOptions`. Passed
 * as the second (positional) argument after the update name.
 */
export type TypedStartUpdateOptions<TUpdate extends UpdateDefinition> = {
  /**
   * Unique ID for this update request (passthrough of Temporal's
   * `updateId`). Meaningful business IDs enable deduplication.
   */
  updateId?: string;
  /**
   * Update lifecycle stage to wait for before the handle is returned.
   * Temporal currently only supports `"ACCEPTED"`, which is also the
   * default — the option exists as a forward-compatible passthrough.
   */
  waitForStage?: "ACCEPTED";
} & (undefined extends ClientInferInput<TUpdate>
  ? { args?: ClientInferInput<TUpdate> }
  : { args: ClientInferInput<TUpdate> });
