import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  AnyWorkflowDefinition,
  ContractDefinition,
  ErrorDefinition,
  InferSignalNames,
  InferUpdateNames,
  SearchAttributeDefinition,
  SearchAttributeKindToType,
  SignalDefinition,
  UpdateDefinition,
} from "@temporal-contract/contract";
import { TechnicalError, type ContractErrorUnion } from "@temporal-contract/contract/errors";
import { _internal_reusePolicyFor } from "@temporal-contract/contract/internal";
import { type Client, type WorkflowHandle, type WorkflowUpdateHandle } from "@temporalio/client";
import type {
  GetWorkflowHandleOptions,
  WorkflowSignalWithStartOptions,
  WorkflowStartOptions,
} from "@temporalio/client";
import { defineSearchAttributeKey, type TypedSearchAttributes } from "@temporalio/common";
import {
  type AsyncResult,
  type Result,
  Ok,
  Err,
  OkAsync,
  ErrAsync,
  fromPromise,
  P,
} from "unthrown";

import {
  WORKFLOW_ALREADY_STARTED_ERROR_TAG,
  WORKFLOW_CANCELLED_ERROR_TAG,
  WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG,
  WORKFLOW_FAILED_ERROR_TAG,
  WORKFLOW_TERMINATED_ERROR_TAG,
  WORKFLOW_TIMEOUT_ERROR_TAG,
} from "./error-tags.js";
import {
  type QueryFailedError,
  type UpdateFailedError,
  type UpdateRejectedError,
  type WorkflowAlreadyStartedError,
  type WorkflowCancelledError,
  type WorkflowExecutionNotFoundError,
  type WorkflowFailedError,
  type WorkflowTerminatedError,
  type WorkflowTimeoutError,
  WorkflowNotInContractError,
  WorkflowValidationError,
  QueryValidationError,
  SignalValidationError,
  UpdateValidationError,
  RuntimeClientError,
} from "./errors.js";
import {
  classifyHandleError,
  classifyQueryError,
  classifyResultError,
  classifyStartError,
  classifyUpdateError,
  makeAsyncResult,
  rehydrateFailedResult,
  toTypedSearchAttributes,
  validateStandardSchema,
} from "./internal.js";
import { TypedScheduleClient } from "./schedule.js";
import type {
  ClientInferInput,
  ClientInferOutput,
  ClientInferWorkflowQueries,
  ClientInferWorkflowSignals,
  ClientInferWorkflowUpdates,
} from "./types.js";

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
 * workflow — the shared tail of {@link ContractClient.executeWorkflow} and
 * {@link TypedWorkflowHandle.result}: any contract error declared on the
 * workflow, plus output validation, the generic completion failure, the
 * three first-class workflow outcomes (cancelled / terminated / timed out),
 * and a missing execution.
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

/**
 * Read declared search attributes off a `TypedSearchAttributes` instance —
 * the read-side counterpart to the write-side `searchAttributes` option on
 * `startWorkflow` / `signalWithStart` / `executeWorkflow` /
 * `schedule.create`.
 *
 * Use it on the result of `handle.describe()` (or a schedule's describe) to
 * recover the typed shape of indexed attributes. The Temporal SDK only
 * exposes a `.get(key)` accessor on `TypedSearchAttributes` and requires
 * the caller to reconstruct each `SearchAttributeKey` from the contract's
 * declared `kind` — this helper does that lookup once for every declared
 * attribute, returning a `Partial<TypedSearchAttributeMap<TWorkflow>>`
 * (each declared key may or may not have been set on the workflow).
 *
 * Workflows without declared `searchAttributes` get an empty object back.
 *
 * @example
 * ```ts
 * const description = await handle.describe();
 * if (description.isOk()) {
 *   const attrs = readTypedSearchAttributes(
 *     myContract.workflows.processOrder,
 *     description.value.typedSearchAttributes,
 *   );
 *   // attrs.customerId: string | undefined
 *   // attrs.priority:   number | undefined
 * }
 * ```
 */
export function readTypedSearchAttributes<TWorkflow extends AnyWorkflowDefinition>(
  workflowDef: TWorkflow,
  instance: TypedSearchAttributes,
): Partial<TypedSearchAttributeMap<TWorkflow>> {
  const declared = workflowDef.searchAttributes as
    | Record<string, SearchAttributeDefinition>
    | undefined;
  if (!declared) return {} as Partial<TypedSearchAttributeMap<TWorkflow>>;

  const result: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(declared)) {
    const key = defineSearchAttributeKey(name, def.kind);
    const value = instance.get(key);
    if (value !== undefined) {
      result[name] = value;
    }
  }
  return result as Partial<TypedSearchAttributeMap<TWorkflow>>;
}

/**
 * The `args` field of the start-shaped options, typed against the
 * workflow's input schema. When the schema accepts `undefined`, the field
 * becomes omittable so input-less workflows don't need `args: undefined`
 * ceremony.
 */
type WorkflowArgsField<TWorkflow extends AnyWorkflowDefinition> =
  undefined extends ClientInferInput<TWorkflow>
    ? { args?: ClientInferInput<TWorkflow> }
    : { args: ClientInferInput<TWorkflow> };

export type TypedWorkflowStartOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
> = Omit<
  WorkflowStartOptions,
  "taskQueue" | "args" | "searchAttributes" | "typedSearchAttributes"
> &
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
 * Options for {@link ContractClient.signalWithStart} — typed against both
 * the workflow's input schema and the named signal's input schema. The
 * signal is addressed by the `signalName` field of this options bag (there
 * is no positional signal parameter), keeping the method at two positional
 * arguments like the rest of the surface.
 */
export type TypedSignalWithStartOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
  TSignalName extends InferSignalNames<TContract["workflows"][TWorkflowName]>,
> = Omit<
  WorkflowSignalWithStartOptions,
  "taskQueue" | "args" | "signal" | "signalArgs" | "searchAttributes" | "typedSearchAttributes"
> &
  WorkflowArgsField<TContract["workflows"][TWorkflowName]> &
  SignalArgsField<TContract["workflows"][TWorkflowName]["signals"][TSignalName]> & {
    signalName: TSignalName;
    /**
     * Indexed search attributes for the started workflow. Keys and value types
     * are constrained to those declared on the workflow's contract via
     * `defineSearchAttribute`. Translated to Temporal's `typedSearchAttributes`
     * before the signalWithStart request is dispatched.
     */
    searchAttributes?: TypedSearchAttributeMap<TContract["workflows"][TWorkflowName]>;
  };

/**
 * Options for {@link ContractClient.getHandle}. Extends Temporal's
 * `GetWorkflowHandleOptions` (`followRuns`, `firstExecutionRunId` — the
 * chain interlock ensuring mutating methods don't cross into another
 * execution chain) with the optional `runId` of the specific execution to
 * bind.
 */
export type TypedGetHandleOptions = GetWorkflowHandleOptions & {
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

/**
 * Union of the modeled errors an update interaction can surface once the
 * request reaches Temporal: client-side payload validation, a worker-side
 * admission rejection, a failed (admitted) handler, or a missing execution.
 */
type UpdateCallError =
  | UpdateValidationError
  | UpdateRejectedError
  | UpdateFailedError
  | WorkflowExecutionNotFoundError;

/**
 * Typed handle to an in-flight update, returned by
 * {@link TypedWorkflowHandle.startUpdate}. `result()` parses the update's
 * outcome against the contract's output schema on receive (the worker
 * transmits its original return value — D1).
 */
export type TypedWorkflowUpdateHandle<TUpdate extends UpdateDefinition> = {
  /** The ID of this update request. */
  readonly updateId: string;
  /** The ID of the workflow execution targeted by this update. */
  readonly workflowId: string;
  /** The run ID of the targeted execution, when known. */
  readonly workflowRunId: string | undefined;
  /**
   * Wait for and return the update's result, parsed against the contract's
   * output schema. A worker-side admission rejection surfaces as
   * `UpdateRejectedError`; a failed (admitted) handler as
   * `UpdateFailedError` — both on the Err channel, never as defects.
   */
  result: () => AsyncResult<ClientInferOutput<TUpdate>, UpdateCallError>;
};

/**
 * Typed workflow handle returned by `signalWithStart`. Adds `signaledRunId`
 * to the standard handle so callers can correlate the signal with the
 * (possibly pre-existing) workflow execution chain.
 */
export type TypedWorkflowHandleWithSignaledRunId<TWorkflow extends AnyWorkflowDefinition> =
  TypedWorkflowHandle<TWorkflow> & {
    /**
     * The Run Id of the bound Workflow at the time of `signalWithStart`. Since
     * `signalWithStart` may have signaled an existing Workflow Chain, this is
     * not necessarily the `firstExecutionRunId`.
     */
    readonly signaledRunId: string;
  };

/**
 * Typed workflow handle with validated results using unthrown Result/AsyncResult
 */
export type TypedWorkflowHandle<TWorkflow extends AnyWorkflowDefinition> = {
  readonly workflowId: string;

  /**
   * Run ID of the execution this handle is bound to, when known: the
   * started run's ID for `startWorkflow` handles, the caller-provided
   * `runId` for `getHandle` handles, `undefined` otherwise (the handle then
   * addresses the latest execution).
   */
  readonly runId: string | undefined;

  /**
   * Run ID of the first execution in the workflow chain, when known (set on
   * handles returned by `startWorkflow`, and on `getHandle` handles when the
   * caller passed `firstExecutionRunId`).
   */
  readonly firstExecutionRunId: string | undefined;

  /**
   * The underlying `@temporalio/client` `WorkflowHandle` — the escape hatch
   * for anything the typed surface doesn't cover yet (e.g.
   * `raw.getUpdateHandle(...)`, `raw.cancel()` with SDK-specific options).
   * Calls made through `raw` bypass contract validation. Mirrors {@link TypedClient.raw} at the handle level.
   */
  readonly raw: WorkflowHandle;

  /**
   * Type-safe queries based on workflow definition with Result pattern.
   * Each query returns an `AsyncResult` — erring with `QueryValidationError`
   * (payload/result schema mismatch), `QueryFailedError` (no handler
   * registered on the execution, or the handler threw), or
   * `WorkflowExecutionNotFoundError` — instead of a throwing `Promise`; the
   * error union is carried by {@link ClientInferWorkflowQueries} directly.
   */
  queries: ClientInferWorkflowQueries<TWorkflow>;

  /**
   * Type-safe signals based on workflow definition with Result pattern.
   * Each signal returns an `AsyncResult` — erring with
   * `SignalValidationError` or `WorkflowExecutionNotFoundError` — instead of
   * a throwing `Promise`; the error union is carried by
   * {@link ClientInferWorkflowSignals} directly.
   */
  signals: ClientInferWorkflowSignals<TWorkflow>;

  /**
   * Type-safe updates based on workflow definition with Result pattern.
   * Each update starts the update AND waits for its result (Temporal's
   * `executeUpdate`), returning an `AsyncResult` that errs with
   * `UpdateValidationError`, `UpdateRejectedError` (worker-side admission
   * rejection), `UpdateFailedError` (the admitted handler failed), or
   * `WorkflowExecutionNotFoundError`; use {@link startUpdate} to obtain an
   * update handle without waiting for completion.
   */
  updates: ClientInferWorkflowUpdates<TWorkflow>;

  /**
   * Start an update without waiting for its completion — Temporal's
   * `startUpdate` beside the `updates` map's execute-and-wait shape. The
   * update is addressed positionally (`startUpdate(updateName, options)`);
   * everything else rides the {@link TypedStartUpdateOptions} bag.
   * Returns a {@link TypedWorkflowUpdateHandle} whose `result()` parses the
   * outcome against the contract's output schema on receive. The `options`
   * parameter is omittable when the update's input schema accepts
   * `undefined` (e.g. an argument-less `defineUpdate({ output })`).
   */
  startUpdate: <TUpdateName extends InferUpdateNames<TWorkflow>>(
    updateName: TUpdateName,
    ...options: TWorkflow["updates"][TUpdateName] extends UpdateDefinition
      ? undefined extends ClientInferInput<TWorkflow["updates"][TUpdateName]>
        ? [options?: TypedStartUpdateOptions<TWorkflow["updates"][TUpdateName]>]
        : [options: TypedStartUpdateOptions<TWorkflow["updates"][TUpdateName]>]
      : never
  ) => AsyncResult<
    TypedWorkflowUpdateHandle<
      TWorkflow["updates"][TUpdateName] extends UpdateDefinition
        ? TWorkflow["updates"][TUpdateName]
        : never
    >,
    UpdateCallError
  >;

  /**
   * Get workflow result with Result pattern. When the workflow declares
   * contract errors, a failed execution whose failure matches a declared
   * error surfaces as that typed error instead of the generic
   * {@link WorkflowFailedError}. A cancelled / terminated / timed-out
   * execution surfaces as the first-class `WorkflowCancelledError` /
   * `WorkflowTerminatedError` / `WorkflowTimeoutError` — no `instanceof`
   * digging through `WorkflowFailedError.cause` required. Cancellation is a
   * modeled `Err(...)`: give it its own matcher arm rather than folding it
   * into a blanket "failed" branch, so a deliberate cancel isn't reported
   * as a breakage.
   */
  result: () => AsyncResult<ClientInferOutput<TWorkflow>, WorkflowResultErrorsOf<TWorkflow>>;

  /**
   * Terminate workflow with Result pattern
   */
  terminate: (reason?: string) => AsyncResult<void, WorkflowExecutionNotFoundError>;

  /**
   * Cancel workflow with Result pattern
   */
  cancel: () => AsyncResult<void, WorkflowExecutionNotFoundError>;

  /**
   * Get workflow execution description including status and metadata
   */
  describe: () => AsyncResult<
    Awaited<ReturnType<WorkflowHandle["describe"]>>,
    WorkflowExecutionNotFoundError
  >;

  /**
   * Fetch the workflow execution history
   */
  fetchHistory: () => AsyncResult<
    Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>,
    WorkflowExecutionNotFoundError
  >;
};

/**
 * Result of {@link resolveDefinitionAndValidateInput} — the contract-side
 * pre-call ritual the start/signal-with-start/execute methods share. Holds
 * the resolved workflow definition and the translated typed search
 * attributes (or `undefined` when the workflow declared none / the caller
 * passed none).
 */
type ResolvedWorkflow<TWorkflow extends AnyWorkflowDefinition> = {
  definition: TWorkflow;
  typedSearchAttributes: TypedSearchAttributes | undefined;
};

/**
 * Shared pre-call ritual for the three contract-driven entry points that
 * actually start a workflow (`startWorkflow`, `signalWithStart`,
 * `executeWorkflow`):
 *
 *   1. Look up the workflow definition on the contract.
 *   2. Surface a `WorkflowNotInContractError` if absent.
 *   3. Validate `args` against the workflow's input schema.
 *   4. Surface a `WorkflowValidationError` if validation fails.
 *   5. Translate any caller-supplied `searchAttributes` into Temporal's
 *      `TypedSearchAttributes` shape (or `undefined`).
 *
 * Step 3 validates to fail early with a typed error, but the parsed value is
 * deliberately DISCARDED: the caller transmits the original `args`, and the
 * worker parses them on receive, so a transforming schema is applied exactly
 * once per boundary (never here on the sending side).
 *
 * Step 5's `toTypedSearchAttributes` throws a `RuntimeClientError` on an
 * undeclared key or a value that doesn't match the declared kind — a
 * technical misconfiguration. The throw happens inside the `flatMap`
 * callback, whose throw→defect net turns it into a defect (never a modeled
 * Err), which then flows through the composed pipeline untouched.
 *
 * `getHandle` deliberately keeps its own three-line lookup — it doesn't
 * accept `args` or `searchAttributes`, so it can't share this helper. The
 * call-specific extras (signal validation, post-call output parsing,
 * extended error classification) stay at the call site — those are the
 * differentiators that make each method distinct.
 */
function resolveDefinitionAndValidateInput<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
>(
  contract: TContract,
  workflowName: TWorkflowName,
  workflowId: string,
  args: unknown,
  searchAttributes: Record<string, unknown> | undefined,
): AsyncResult<
  ResolvedWorkflow<TContract["workflows"][TWorkflowName]>,
  WorkflowNotInContractError | WorkflowValidationError
> {
  const definition = contract.workflows[workflowName];
  if (!definition) {
    return ErrAsync(createWorkflowNotInContractError(workflowName, contract));
  }

  return validateStandardSchema(definition.input, args).flatMap((inputResult) => {
    if (inputResult.issues) {
      return Err(
        new WorkflowValidationError(workflowName, "input", inputResult.issues, workflowId),
      );
    }
    const typedSearchAttributes = toTypedSearchAttributes(
      definition,
      workflowName,
      searchAttributes,
    );
    return Ok({
      definition: definition as TContract["workflows"][TWorkflowName],
      typedSearchAttributes,
    });
  });
}

/**
 * Options for {@link TypedClient.create} — the single options-object shape
 * shared by the org's `Typed*.create()` factories.
 */
export type CreateClientOptions = {
  /** The underlying `@temporalio/client` `Client`. */
  client: Client;
};

/**
 * Connection-scoped root of the typed client surface.
 *
 * A client is a *connection*; a contract is a *schema*. `TypedClient` owns
 * the connection-lifetime concerns — the eager `ensureConnected()`, the
 * `@temporalio/client` capability check and the
 * {@link TypedClient.raw | raw} escape hatch — and hands out contract-bound
 * {@link ContractClient}s via {@link TypedClient.for}. Create it once at
 * process start; bind contracts freely (binding is synchronous, infallible,
 * and memoized).
 */
export class TypedClient {
  /**
   * The underlying `@temporalio/client` `Client` — the escape hatch for
   * anything the typed surface doesn't cover yet (e.g.
   * `raw.workflow.list(...)`, `raw.workflow.count(...)`). Calls made through
   * `raw` bypass contract validation.
   */
  readonly raw: Client;

  /**
   * Memoized contract bindings, keyed by contract identity, so
   * `for(c) === for(c)` and repeated binding in hot paths doesn't rebuild
   * the `TypedScheduleClient`. The map erases the contract's type
   * parameter; the two casts in {@link TypedClient.for} restore it.
   */
  private readonly contractClients = new WeakMap<
    ContractDefinition,
    ContractClient<ContractDefinition>
  >();

  private constructor(client: Client) {
    this.raw = client;
  }

  /**
   * Create the connection-scoped typed client.
   *
   * Returns `AsyncResult<TypedClient, never>` — setup faults are *technical*
   * infrastructure failures, not anticipated domain errors, so they surface on
   * the `Defect` channel (a {@link TechnicalError} instance as the defect's
   * cause), never the modeled `Err` channel. Technical failures routed there:
   *
   * - the underlying `Client` lacks the Schedule API
   *   (`@temporalio/client` < 1.16);
   * - the connection cannot be established (when the client's connection
   *   exposes `ensureConnected`, it is awaited eagerly so a bad
   *   address/namespace surfaces here instead of on the first operation).
   *
   * @example
   * ```ts
   * import { TypedClient } from "@temporal-contract/client";
   * import { Client, Connection } from "@temporalio/client";
   *
   * const connection = await Connection.connect();
   * const temporalClient = new Client({ connection });
   *
   * // Once, at process start. The Err channel is empty (`never`), so
   * // `.get()` unwraps directly — a setup defect rethrows its cause.
   * const client = await TypedClient.create({ client: temporalClient }).get();
   * ```
   */
  static create({ client }: CreateClientOptions): AsyncResult<TypedClient, never> {
    const work = async () => {
      // `client.schedule` is the ScheduleClient wired into Temporal's
      // top-level `Client` since 1.16. The peer dep allows all of `^1`, so a
      // consumer can be on an older version — fail early with a clear
      // message rather than crashing later with a confusing
      // `Cannot read properties of undefined`. This is a property of the
      // connection's client, not of any contract, hence checked here rather
      // than in `for()`.
      if (!client.schedule) {
        // Technical setup fault — `makeAsyncResult`'s throw→defect net
        // routes it to the defect channel (never a modeled Err).
        // oxlint-disable-next-line unthrown/no-throw -- defect-channel routing: this throw inside the makeAsyncResult work thunk IS how a technical fault becomes a defect, never a modeled Err
        throw new TechnicalError(
          "TypedClient requires @temporalio/client >= 1.16 (the Schedule API was added in 1.16). " +
            "Found a Client instance without a `schedule` property — please upgrade.",
        );
      }

      // Surface connection failures at creation time when the client can be
      // eagerly connected. `ensureConnected` exists on `Connection` (lazy
      // gRPC channel); mock/custom `ConnectionLike`s without it are accepted
      // as-is.
      const connection = (client as { connection?: { ensureConnected?: () => Promise<void> } })
        .connection;
      if (connection && typeof connection.ensureConnected === "function") {
        try {
          await connection.ensureConnected();
        } catch (error) {
          // Technical connection fault — route to the defect channel too.
          // oxlint-disable-next-line unthrown/no-throw -- defect-channel routing: this throw inside the makeAsyncResult work thunk IS how a technical fault becomes a defect, never a modeled Err
          throw new TechnicalError("Failed to connect to Temporal server", error);
        }
      }

      return Ok(new TypedClient(client));
    };
    return makeAsyncResult(work);
  }

  /**
   * Bind a contract, returning a {@link ContractClient} typed against it.
   *
   * Synchronous and infallible — binding a schema to an established
   * connection is a free, compile-time-ish operation, so it's valid in a
   * field initializer. Memoized per contract identity: the option-less
   * `for(c) === for(c)` guarantee holds, so calling it per request is free.
   *
   * @example
   * ```ts
   * import {
   *   WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG,
   *   WORKFLOW_VALIDATION_ERROR_TAG,
   * } from "@temporal-contract/client";
   * import { P } from "unthrown";
   *
   * import { orderContract } from "./contracts/order.contract.js";
   *
   * const orders = client.for(orderContract);
   *
   * const result = await orders.executeWorkflow("processOrder", {
   *   workflowId: "order-123",
   *   args: { orderId: "ORD-123" },
   * });
   *
   * await result.match({
   *   ok: (output) => console.log("processed", output),
   *   errCases: (matcher) =>
   *     matcher.with(
   *       P.tag(WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG),
   *       P.tag(WORKFLOW_VALIDATION_ERROR_TAG),
   *       // ...one P.tag per remaining member of the union
   *       (error) => console.error("processing failed", error),
   *     ),
   *   defect: (cause) => console.error("unexpected failure", cause),
   * });
   * ```
   */
  for<TContract extends ContractDefinition>(contract: TContract): ContractClient<TContract> {
    // The WeakMap erases the contract's type parameter; these two casts
    // restore/erase it at the memo boundary (see the field's doc).
    const memoized = this.contractClients.get(contract);
    if (memoized) return memoized as unknown as ContractClient<TContract>;
    const bound = ContractClient._internal_create(contract, this.raw);
    this.contractClients.set(contract, bound as unknown as ContractClient<ContractDefinition>);
    return bound;
  }
}

/**
 * Contract-scoped typed Temporal client with unthrown Result/AsyncResult
 * pattern.
 *
 * Provides type-safe methods to start and execute workflows defined in the
 * bound contract, with explicit error handling using the Result pattern.
 * Obtained from {@link TypedClient.for} — the connection-scoped root — and
 * inherits its underlying `Client`. Not constructible
 * directly: the class is exported for type annotations only.
 */
export class ContractClient<TContract extends ContractDefinition> {
  /**
   * The contract this client is bound to — handy for logging, metrics
   * labels, and plumbing the same contract into workers/tests without
   * threading a second reference around.
   */
  readonly contract: TContract;

  /**
   * Typed wrapper around Temporal's `client.schedule.create(...)` and
   * related lifecycle methods. Fires the underlying `startWorkflow` action
   * with args validated against the contract's input schema.
   *
   * **Requires `@temporalio/client` 1.16+.** The Schedule API was added in
   * 1.16; {@link TypedClient.create} fails fast (a defect with a clear
   * message) when the underlying `Client` predates it.
   *
   * @example
   * ```ts
   * import { P } from "unthrown";
   *
   * const result = await contractClient.schedule.create("processOrder", {
   *   scheduleId: "daily-sweep",
   *   spec: { cronExpressions: ["0 2 * * *"] },
   *   args: { orderId: "sweep" },
   * });
   *
   * await result.match({
   *   ok: async (handle) => { await handle.pause("maintenance"); },
   *   errCases: (matcher) =>
   *     matcher.with(
   *       P.tag("@temporal-contract/WorkflowNotInContractError"),
   *       P.tag("@temporal-contract/WorkflowValidationError"),
   *       P.tag("@temporal-contract/ScheduleAlreadyExistsError"),
   *       (error) => console.error("schedule create failed", error),
   *     ),
   *   defect: (cause) => console.error("unexpected failure", cause),
   * });
   * ```
   */
  readonly schedule: TypedScheduleClient<TContract>;

  private readonly client: Client;

  private constructor(contract: TContract, client: Client) {
    this.contract = contract;
    this.client = client;
    this.schedule = TypedScheduleClient._internal_create(contract, client.schedule);
  }

  /**
   * Constructed exclusively by {@link TypedClient.for}. Not part of the
   * public API — obtain instances via `typedClient.for(contract)`.
   *
   * @internal
   */
  static _internal_create<TContract extends ContractDefinition>(
    contract: TContract,
    client: Client,
  ): ContractClient<TContract> {
    return new ContractClient(contract, client);
  }

  /**
   * The task queue this client dispatches to — the bound contract's
   * `taskQueue`. Exposed for logging/observability so callers don't need to
   * reach through {@link contract}.
   */
  get taskQueue(): TContract["taskQueue"] {
    return this.contract.taskQueue;
  }

  /**
   * Start a workflow and return a typed handle with AsyncResult pattern
   *
   * @example
   * ```ts
   * import {
   *   WORKFLOW_ALREADY_STARTED_ERROR_TAG,
   *   WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG,
   *   WORKFLOW_VALIDATION_ERROR_TAG,
   * } from "@temporal-contract/client";
   * import { P } from "unthrown";
   *
   * const handleResult = await contractClient.startWorkflow('processOrder', {
   *   workflowId: 'order-123',
   *   args: { orderId: 'ORD-123' },
   *   workflowExecutionTimeout: '1 day',
   *   retry: { maximumAttempts: 3 },
   * });
   *
   * await handleResult.match({
   *   ok: async (handle) => {
   *     const result = await handle.result();
   *     // ... handle result
   *   },
   *   errCases: (matcher) =>
   *     matcher.with(
   *       P.tag(WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG),
   *       P.tag(WORKFLOW_VALIDATION_ERROR_TAG),
   *       P.tag(WORKFLOW_ALREADY_STARTED_ERROR_TAG),
   *       (error) => console.error('Failed to start:', error),
   *     ),
   *   defect: (cause) => console.error('Unexpected failure:', cause),
   * });
   * ```
   */
  startWorkflow<TWorkflowName extends keyof TContract["workflows"] & string>(
    workflowName: TWorkflowName,
    options: TypedWorkflowStartOptions<TContract, TWorkflowName>,
  ): AsyncResult<
    TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>,
    WorkflowNotInContractError | WorkflowValidationError | WorkflowAlreadyStartedError
  > {
    // Widen once at the boundary: `args` is a conditional type (omittable
    // for undefined-accepting inputs), which the rest-spread below can't
    // decompose while it's still generic.
    const { args, searchAttributes, ...temporalOptions } = options as Omit<
      WorkflowStartOptions,
      "taskQueue" | "args" | "searchAttributes" | "typedSearchAttributes"
    > & { args?: unknown; searchAttributes?: Record<string, unknown> };
    type StartOk = TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>;
    type StartErr =
      | WorkflowNotInContractError
      | WorkflowValidationError
      | WorkflowAlreadyStartedError;

    const runPipeline = (currentInput: unknown): AsyncResult<StartOk, StartErr> =>
      resolveDefinitionAndValidateInput(
        this.contract,
        workflowName,
        temporalOptions.workflowId,
        currentInput,
        searchAttributes as Record<string, unknown> | undefined,
      ).flatMap(({ definition, typedSearchAttributes }) =>
        // Transmit the caller's ORIGINAL args — the input was validated
        // above (fail early), but the worker parses on receive, so the
        // parsed value must not cross the wire (D1). An omitted payload
        // travels as empty args, not `[undefined]`.
        fromPromise(
          this.client.workflow.start(workflowName, {
            ...(definition.idempotency
              ? { workflowIdReusePolicy: _internal_reusePolicyFor(definition.idempotency) }
              : {}),
            ...temporalOptions,
            taskQueue: this.contract.taskQueue,
            args: currentInput === undefined ? [] : [currentInput],
            ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
          }),
          // A start collision is the modeled Err; any other rejection is an
          // unrecognized technical failure routed to the defect channel.
          (error, defect) =>
            classifyStartError(error) ?? defect(new RuntimeClientError("startWorkflow", error)),
        ).map(
          (handle) =>
            this.createTypedHandle(handle, workflowName, definition, {
              runId: handle.firstExecutionRunId,
              firstExecutionRunId: handle.firstExecutionRunId,
            }) as StartOk,
        ),
      );

    return runPipeline(args);
  }

  /**
   * Send a signal to a workflow, starting it first if it doesn't already exist.
   *
   * Validates both halves of the call against the contract:
   * - `args` against the workflow's input schema
   * - `signalArgs` against the input schema of the signal named by the
   *   options bag's `signalName` field
   *
   * Returns a `TypedWorkflowHandleWithSignaledRunId` — the same shape as
   * `startWorkflow`'s handle, plus a `signaledRunId` field for correlating
   * the signal with the (possibly pre-existing) workflow execution chain.
   *
   * @example
   * ```ts
   * import {
   *   SIGNAL_VALIDATION_ERROR_TAG,
   *   WORKFLOW_ALREADY_STARTED_ERROR_TAG,
   *   WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG,
   *   WORKFLOW_VALIDATION_ERROR_TAG,
   * } from "@temporal-contract/client";
   * import { P } from "unthrown";
   *
   * const result = await contractClient.signalWithStart('processOrder', {
   *   workflowId: 'order-123',
   *   args: { orderId: 'ORD-123', customerId: 'CUST-1' },
   *   signalName: 'cancel',
   *   signalArgs: { reason: 'duplicate' },
   * });
   *
   * await result.match({
   *   ok: (handle) => console.log('signaled run', handle.signaledRunId),
   *   errCases: (matcher) =>
   *     matcher
   *       .with(P.tag(SIGNAL_VALIDATION_ERROR_TAG), (error) =>
   *         console.error('signal payload rejected', error),
   *       )
   *       .with(
   *         P.tag(WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG),
   *         P.tag(WORKFLOW_VALIDATION_ERROR_TAG),
   *         P.tag(WORKFLOW_ALREADY_STARTED_ERROR_TAG),
   *         (error) => console.error('signalWithStart failed', error),
   *       ),
   *   defect: (cause) => console.error('unexpected failure', cause),
   * });
   * ```
   */
  signalWithStart<
    TWorkflowName extends keyof TContract["workflows"] & string,
    TSignalName extends InferSignalNames<TContract["workflows"][TWorkflowName]>,
  >(
    workflowName: TWorkflowName,
    options: TypedSignalWithStartOptions<TContract, TWorkflowName, TSignalName>,
  ): AsyncResult<
    TypedWorkflowHandleWithSignaledRunId<TContract["workflows"][TWorkflowName]>,
    | WorkflowNotInContractError
    | WorkflowValidationError
    | SignalValidationError
    | WorkflowAlreadyStartedError
  > {
    // Widen once at the boundary — `args`/`signalArgs` are conditional
    // types (omittable for undefined-accepting inputs), which the
    // rest-spread below can't decompose while they're still generic.
    const { args, signalName, signalArgs, searchAttributes, ...temporalOptions } = options as Omit<
      WorkflowSignalWithStartOptions,
      "taskQueue" | "args" | "signal" | "signalArgs" | "searchAttributes" | "typedSearchAttributes"
    > & {
      args?: unknown;
      signalName: string;
      signalArgs?: unknown;
      searchAttributes?: Record<string, unknown>;
    };
    type SignalStartOk = TypedWorkflowHandleWithSignaledRunId<
      TContract["workflows"][TWorkflowName]
    >;
    type SignalStartErr =
      | WorkflowNotInContractError
      | WorkflowValidationError
      | SignalValidationError
      | WorkflowAlreadyStartedError;

    const runPipeline = (
      currentInput: unknown,
      currentSignalInput: unknown,
    ): AsyncResult<SignalStartOk, SignalStartErr> =>
      resolveDefinitionAndValidateInput(
        this.contract,
        workflowName,
        temporalOptions.workflowId,
        currentInput,
        searchAttributes as Record<string, unknown> | undefined,
      )
        .flatMap((resolved) => {
          // Validate signal input — call-site-specific, kept inline. Like the
          // workflow input, the parsed value is discarded: the signal handler
          // parses on receive, so the original signal args go over the wire.
          const signalDef = (
            resolved.definition.signals as Record<string, SignalDefinition> | undefined
          )?.[signalName];
          if (!signalDef) {
            // Type-level constraint should already prevent this; defensive for
            // raw-call / union-typed-name corner cases.
            return ErrAsync(
              new SignalValidationError(signalName, [
                {
                  message: `Signal "${signalName}" is not declared on workflow "${workflowName}".`,
                },
              ]),
            );
          }
          return validateStandardSchema(signalDef.input, currentSignalInput).flatMap(
            (signalInputResult) =>
              signalInputResult.issues
                ? Err(new SignalValidationError(signalName, signalInputResult.issues))
                : Ok(resolved),
          );
        })
        .flatMap(({ definition, typedSearchAttributes }) =>
          fromPromise(
            this.client.workflow.signalWithStart(workflowName, {
              ...(definition.idempotency
                ? { workflowIdReusePolicy: _internal_reusePolicyFor(definition.idempotency) }
                : {}),
              ...temporalOptions,
              taskQueue: this.contract.taskQueue,
              args: currentInput === undefined ? [] : [currentInput],
              signal: signalName,
              // An omitted signal payload travels as empty signalArgs. The
              // cast collapses the `[] | [unknown]` union the SDK's overload
              // inference can't split.
              signalArgs: (currentSignalInput === undefined
                ? []
                : [currentSignalInput]) as unknown[],
              ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
            }),
            (error, defect) =>
              classifyStartError(error) ?? defect(new RuntimeClientError("signalWithStart", error)),
          ).map((handle) => {
            const typed = this.createTypedHandle(
              handle,
              workflowName,
              definition,
            ) as TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>;
            return { ...typed, signaledRunId: handle.signaledRunId } as SignalStartOk;
          }),
        );

    return runPipeline(args, signalArgs);
  }

  /**
   * Execute a workflow (start and wait for result) with AsyncResult pattern.
   *
   * Beside the start-phase errors, the result phase surfaces the workflow's
   * declared contract errors and the first-class outcome errors
   * (`WorkflowCancelledError` / `WorkflowTerminatedError` /
   * `WorkflowTimeoutError`) — see {@link TypedWorkflowHandle.result} for the
   * cancellation-handling caveat.
   *
   * @example
   * ```ts
   * import {
   *   WORKFLOW_FAILED_ERROR_TAG,
   *   WORKFLOW_VALIDATION_ERROR_TAG,
   * } from "@temporal-contract/client";
   * import { P } from "unthrown";
   *
   * const result = await contractClient.executeWorkflow('processOrder', {
   *   workflowId: 'order-123',
   *   args: { orderId: 'ORD-123' },
   *   workflowExecutionTimeout: '1 day',
   *   retry: { maximumAttempts: 3 },
   * });
   *
   * await result.match({
   *   ok: (output) => console.log('Order processed:', output.status),
   *   errCases: (matcher) =>
   *     matcher
   *       .with(P.tag('@temporal-contract/ContractError'), (error) =>
   *         console.error('Domain failure:', error.errorName),
   *       )
   *       .with(
   *         P.tag(WORKFLOW_VALIDATION_ERROR_TAG),
   *         P.tag(WORKFLOW_FAILED_ERROR_TAG),
   *         // ...one P.tag per remaining member of the union
   *         (error) => console.error('Processing failed:', error),
   *       ),
   *   defect: (cause) => console.error('Unexpected failure:', cause),
   * });
   * ```
   */
  executeWorkflow<TWorkflowName extends keyof TContract["workflows"] & string>(
    workflowName: TWorkflowName,
    options: TypedWorkflowStartOptions<TContract, TWorkflowName>,
  ): AsyncResult<
    ClientInferOutput<TContract["workflows"][TWorkflowName]>,
    | WorkflowResultErrorsOf<TContract["workflows"][TWorkflowName]>
    | WorkflowNotInContractError
    | WorkflowAlreadyStartedError
  > {
    // Widen once at the boundary — same rationale as `startWorkflow`.
    const { args, searchAttributes, ...temporalOptions } = options as Omit<
      WorkflowStartOptions,
      "taskQueue" | "args" | "searchAttributes" | "typedSearchAttributes"
    > & { args?: unknown; searchAttributes?: Record<string, unknown> };
    type ExecuteOk = ClientInferOutput<TContract["workflows"][TWorkflowName]>;
    type ExecuteErr =
      | WorkflowResultErrorsOf<TContract["workflows"][TWorkflowName]>
      | WorkflowNotInContractError
      | WorkflowAlreadyStartedError;

    const runPipeline = (currentInput: unknown): AsyncResult<ExecuteOk, ExecuteErr> =>
      resolveDefinitionAndValidateInput(
        this.contract,
        workflowName,
        temporalOptions.workflowId,
        currentInput,
        searchAttributes as Record<string, unknown> | undefined,
      ).flatMap(({ definition, typedSearchAttributes }) =>
        // Transmit the caller's ORIGINAL args (validated above, parsed by
        // the worker on receive — D1).
        fromPromise(
          this.client.workflow.execute(workflowName, {
            ...(definition.idempotency
              ? { workflowIdReusePolicy: _internal_reusePolicyFor(definition.idempotency) }
              : {}),
            ...temporalOptions,
            taskQueue: this.contract.taskQueue,
            args: currentInput === undefined ? [] : [currentInput],
            ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
          }),
          // executeWorkflow combines start + result, so it can surface any
          // of the discriminated kinds: the start-phase classification
          // first, then the shared result-phase classification (which
          // splits the outcome trio off the generic failure). Anything
          // unrecognized is a technical failure on the defect channel.
          (error, defect) =>
            classifyStartError(error) ??
            classifyResultError(error, temporalOptions.workflowId) ??
            defect(new RuntimeClientError("executeWorkflow", error)),
        )
          .flatMapErrCases((matcher) =>
            matcher
              // Async tail: a failure matching one of the workflow's
              // declared contract errors rehydrates into the typed error;
              // otherwise the generic WorkflowFailedError flows through.
              // The cast narrows `AnyContractError` to this workflow's
              // precise declared-error union (same erase/restore pattern
              .with(
                P.tag(WORKFLOW_FAILED_ERROR_TAG),
                (failed) =>
                  rehydrateFailedResult(definition, failed) as AsyncResult<
                    never,
                    | WorkflowContractErrorsOf<TContract["workflows"][TWorkflowName]>
                    | WorkflowFailedError
                  >,
              )
              .with(
                P.tag(WORKFLOW_ALREADY_STARTED_ERROR_TAG),
                P.tag(WORKFLOW_CANCELLED_ERROR_TAG),
                P.tag(WORKFLOW_TERMINATED_ERROR_TAG),
                P.tag(WORKFLOW_TIMEOUT_ERROR_TAG),
                P.tag(WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG),
                (error) => Err(error),
              ),
          )
          .flatMap((result) =>
            // Output parsing runs *after* the Temporal call returns — the
            // RECEIVING side of the result boundary: the worker validated
            // and transmitted its original return value, so the parse (and
            // any schema transform) happens exactly once, here.
            validateStandardSchema(definition.output, result).flatMap((outputResult) =>
              outputResult.issues
                ? Err(
                    new WorkflowValidationError(
                      workflowName,
                      "output",
                      outputResult.issues,
                      temporalOptions.workflowId,
                    ),
                  )
                : Ok(outputResult.value as ExecuteOk),
            ),
          ),
      );

    return runPipeline(args);
  }

  /**
   * Get a typed handle to an existing workflow execution.
   *
   * Synchronous — the only failure mode is a workflow name missing from the
   * contract, surfaced as a sync `Result` Err. Whether the *execution*
   * exists is a server-side question answered lazily by the handle's
   * methods (as {@link WorkflowExecutionNotFoundError}).
   *
   * Accepts an optional `runId` (bind to a specific execution) and
   * Temporal's `GetWorkflowHandleOptions` passthrough — in particular
   * `firstExecutionRunId`, the chain interlock ensuring mutating handle
   * methods (`terminate`, `cancel`) don't affect executions from another
   * chain reusing the workflow ID.
   *
   * @example
   * ```ts
   * const handleResult = contractClient.getHandle('processOrder', 'order-123');
   * if (!handleResult.isOk()) {
   *   console.error('Unknown workflow:', handleResult.isErr() ? handleResult.error : handleResult.cause);
   *   return;
   * }
   * const result = await handleResult.value.result();
   * ```
   */
  getHandle<TWorkflowName extends keyof TContract["workflows"] & string>(
    workflowName: TWorkflowName,
    workflowId: string,
    options?: TypedGetHandleOptions,
  ): Result<
    TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>,
    WorkflowNotInContractError
  > {
    const definition = this.contract.workflows[workflowName] as
      | TContract["workflows"][TWorkflowName]
      | undefined;
    if (!definition) {
      return Err(createWorkflowNotInContractError(workflowName, this.contract));
    }

    const { runId, ...handleOptions }: TypedGetHandleOptions = options ?? {};
    const handle = this.client.workflow.getHandle(workflowId, runId, handleOptions);
    return Ok(
      this.createTypedHandle(handle, workflowName, definition, {
        runId,
        firstExecutionRunId: handleOptions.firstExecutionRunId,
      }),
    );
  }

  private createTypedHandle<TWorkflow extends AnyWorkflowDefinition>(
    workflowHandle: WorkflowHandle,
    workflowName: string,
    definition: TWorkflow,
    ids: { runId?: string | undefined; firstExecutionRunId?: string | undefined } = {},
  ): TypedWorkflowHandle<TWorkflow> {
    const queries = buildValidatedProxy({
      defs: definition.queries,
      operation: "query",
      makeValidationError: (name, direction, issues) =>
        new QueryValidationError(name, direction, issues),
      invoke: (name, input) =>
        input === undefined ? workflowHandle.query(name) : workflowHandle.query(name, input),
      validateOutput: (def) => def.output,
      // An unregistered handler / a throwing query handler is a routine
      // operational outcome, modeled beside the missing execution.
      classifyError: (error, name) =>
        classifyHandleError(error, workflowHandle.workflowId) ?? classifyQueryError(error, name),
    }) as TypedWorkflowHandle<TWorkflow>["queries"];

    const signals = buildValidatedProxy({
      defs: definition.signals,
      operation: "signal",
      makeValidationError: (name, _direction, issues) => new SignalValidationError(name, issues),
      invoke: async (name, input) => {
        // A payload-less send travels as empty args, not `[undefined]`.
        if (input === undefined) {
          await workflowHandle.signal(name);
        } else {
          await workflowHandle.signal(name, input);
        }
        return undefined;
      },
      validateOutput: () => null,
      classifyError: (error) => classifyHandleError(error, workflowHandle.workflowId),
    }) as TypedWorkflowHandle<TWorkflow>["signals"];

    const updates = buildValidatedProxy({
      defs: definition.updates,
      operation: "update",
      makeValidationError: (name, direction, issues) =>
        new UpdateValidationError(name, direction, issues),
      invoke: (name, input) =>
        workflowHandle.executeUpdate(name, {
          args: (input === undefined ? [] : [input]) as [unknown],
        }),
      validateOutput: (def) => def.output,
      // A rejected admission / failed handler is a routine business
      // failure, modeled beside the missing execution.
      classifyError: (error, name) =>
        classifyHandleError(error, workflowHandle.workflowId) ?? classifyUpdateError(error, name),
    }) as TypedWorkflowHandle<TWorkflow>["updates"];

    const wrapUpdateHandle = (
      updateHandle: WorkflowUpdateHandle<unknown>,
      updateName: string,
      updateDef: UpdateDefinition,
    ): TypedWorkflowUpdateHandle<UpdateDefinition> => ({
      updateId: updateHandle.updateId,
      workflowId: updateHandle.workflowId,
      workflowRunId: updateHandle.workflowRunId,
      result: (): AsyncResult<unknown, UpdateCallError> =>
        fromPromise(
          updateHandle.result(),
          (error, defect) =>
            classifyHandleError(error, updateHandle.workflowId) ??
            classifyUpdateError(error, updateName) ??
            defect(new RuntimeClientError("update.result", error)),
        ).flatMap((raw) =>
          // Receive side of the update-result boundary: the handler
          // transmitted its original return value; parse it here (D1).
          validateStandardSchema(updateDef.output, raw).flatMap((outputResult) =>
            outputResult.issues
              ? Err(new UpdateValidationError(updateName, "output", outputResult.issues))
              : Ok(outputResult.value),
          ),
        ),
    });

    const startUpdate = (
      updateName: string,
      options?: { args?: unknown; updateId?: string; waitForStage?: "ACCEPTED" },
    ): AsyncResult<unknown, UpdateCallError> => {
      const runPipeline = (currentInput: unknown): AsyncResult<unknown, UpdateCallError> => {
        const updateDef = (definition.updates as Record<string, UpdateDefinition> | undefined)?.[
          updateName
        ];
        if (!updateDef) {
          // Type-level constraint should already prevent this; defensive
          // for raw-call / union-typed-name corner cases.
          return ErrAsync(
            new UpdateValidationError(updateName, "input", [
              {
                message: `Update "${updateName}" is not declared on workflow "${workflowName}".`,
              },
            ]),
          );
        }
        return validateStandardSchema(updateDef.input, currentInput).flatMap(
          (inputResult): AsyncResult<unknown, UpdateCallError> => {
            if (inputResult.issues) {
              return ErrAsync(new UpdateValidationError(updateName, "input", inputResult.issues));
            }
            // Send the ORIGINAL input — the update handler parses on
            // receive (D1). An omitted payload travels as empty args.
            return fromPromise(
              workflowHandle.startUpdate(updateName, {
                args: (currentInput === undefined ? [] : [currentInput]) as [unknown],
                waitForStage: options?.waitForStage ?? "ACCEPTED",
                ...(options?.updateId !== undefined ? { updateId: options.updateId } : {}),
              }),
              (error, defect) =>
                classifyHandleError(error, workflowHandle.workflowId) ??
                classifyUpdateError(error, updateName) ??
                defect(new RuntimeClientError("startUpdate", error)),
            ).map((updateHandle) => wrapUpdateHandle(updateHandle, updateName, updateDef));
          },
        );
      };

      return runPipeline(options?.args);
    };

    return {
      workflowId: workflowHandle.workflowId,
      runId: ids.runId,
      firstExecutionRunId: ids.firstExecutionRunId,
      raw: workflowHandle,
      queries,
      signals,
      updates,
      startUpdate: startUpdate as TypedWorkflowHandle<TWorkflow>["startUpdate"],
      result: (): AsyncResult<ClientInferOutput<TWorkflow>, WorkflowResultErrorsOf<TWorkflow>> => {
        type ResultOk = ClientInferOutput<TWorkflow>;
        return fromPromise(
          workflowHandle.result(),
          // Result-phase classification: contract-error rehydration happens
          // in the async errCases tail below; everything unrecognized is a
          // technical failure on the defect channel.
          (error, defect) =>
            classifyResultError(error, workflowHandle.workflowId) ??
            defect(new RuntimeClientError("result", error)),
        )
          .flatMapErrCases((matcher) =>
            matcher
              // A failure matching one of the workflow's declared contract
              // errors rehydrates into the typed error; everything else
              // flows through unchanged.
              .with(
                P.tag(WORKFLOW_FAILED_ERROR_TAG),
                (failed) =>
                  rehydrateFailedResult(definition, failed) as AsyncResult<
                    never,
                    WorkflowContractErrorsOf<TWorkflow> | WorkflowFailedError
                  >,
              )
              .with(
                P.tag(WORKFLOW_CANCELLED_ERROR_TAG),
                P.tag(WORKFLOW_TERMINATED_ERROR_TAG),
                P.tag(WORKFLOW_TIMEOUT_ERROR_TAG),
                P.tag(WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG),
                (error) => Err(error),
              ),
          )
          .flatMap((result) =>
            validateStandardSchema(definition.output, result).flatMap((outputResult) =>
              outputResult.issues
                ? Err(
                    new WorkflowValidationError(
                      workflowName,
                      "output",
                      outputResult.issues,
                      workflowHandle.workflowId,
                    ),
                  )
                : Ok(outputResult.value as ResultOk),
            ),
          );
      },
      terminate: (reason?: string): AsyncResult<void, WorkflowExecutionNotFoundError> =>
        fromPromise(
          workflowHandle.terminate(reason),
          (error, defect) =>
            classifyHandleError(error, workflowHandle.workflowId) ??
            defect(new RuntimeClientError("terminate", error)),
        ).map(() => undefined),
      cancel: (): AsyncResult<void, WorkflowExecutionNotFoundError> =>
        fromPromise(
          workflowHandle.cancel(),
          (error, defect) =>
            classifyHandleError(error, workflowHandle.workflowId) ??
            defect(new RuntimeClientError("cancel", error)),
        ).map(() => undefined),
      describe: (): AsyncResult<
        Awaited<ReturnType<WorkflowHandle["describe"]>>,
        WorkflowExecutionNotFoundError
      > =>
        fromPromise(
          workflowHandle.describe(),
          (error, defect) =>
            classifyHandleError(error, workflowHandle.workflowId) ??
            defect(new RuntimeClientError("describe", error)),
        ),
      fetchHistory: (): AsyncResult<
        Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>,
        WorkflowExecutionNotFoundError
      > =>
        fromPromise(
          workflowHandle.fetchHistory(),
          (error, defect) =>
            classifyHandleError(error, workflowHandle.workflowId) ??
            defect(new RuntimeClientError("fetchHistory", error)),
        ),
    };
  }
}

function createWorkflowNotInContractError(
  workflowName: string | number | symbol,
  contract: ContractDefinition,
): WorkflowNotInContractError {
  return new WorkflowNotInContractError(String(workflowName), Object.keys(contract.workflows));
}

type DefWithInput = { readonly input: StandardSchemaV1 };

/**
 * Union of the modeled operation errors the three handle proxies can
 * classify an invoke rejection into. The builder is typed against this
 * widened union (each call site's `classifyError` produces the relevant
 * subset); the public per-operation precision lives on the
 * `ClientInferSignal` / `ClientInferQuery` / `ClientInferUpdate` types the
 * proxies are cast to.
 */
type ProxyOperationError =
  | WorkflowExecutionNotFoundError
  | QueryFailedError
  | UpdateFailedError
  | UpdateRejectedError;

type ProxyOptions<TDef extends DefWithInput, TValidationError extends Error> = {
  readonly defs: Record<string, TDef> | undefined;
  /** Operation label carried into `RuntimeClientError` on an unclassified failure. */
  readonly operation: "signal" | "query" | "update";
  readonly makeValidationError: (
    name: string,
    direction: "input" | "output",
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) => TValidationError;
  /**
   * Dispatch the call to Temporal. Receives the caller's ORIGINAL input —
   * validated against the contract, but untransformed: the workflow-side
   * handler parses the payload on receive (D1). An `undefined` input means
   * the caller omitted the payload; implementations send empty args.
   */
  readonly invoke: (name: string, input: unknown) => Promise<unknown>;
  /**
   * Returns the schema to parse the invoke result against, or `null` to skip
   * output parsing (used by signals, which don't return a value).
   */
  readonly validateOutput: (def: TDef) => StandardSchemaV1 | null;
  /**
   * Recognize an `invoke` rejection as a modeled operation error (a missing
   * execution, a rejected update, an unregistered query, …). Returns
   * `undefined` for anything else — an unrecognized, technical failure the
   * proxy routes to the defect channel with a {@link RuntimeClientError}
   * cause.
   */
  readonly classifyError: (error: unknown, name: string) => ProxyOperationError | undefined;
};

/**
 * Build a `{ name: (args) => AsyncResult<...> }` proxy for a contract's
 * queries/signals/updates. The three call sites differ only in how they
 * invoke Temporal, whether they parse output, and how they classify invoke
 * rejections, so the shared input-validate → invoke(original) →
 * output-parse pipeline lives here once — as an `AsyncResult` combinator
 * chain whose boundary (`fromPromise`) triages every rejection through the
 * per-operation `classifyError`. Per the wire-format contract (D1), input
 * validation only gates the call — the original value is transmitted and
 * the worker parses it — while the result is parsed here on the receiving
 * side.
 */
function buildValidatedProxy<TDef extends DefWithInput, TValidationError extends Error>({
  defs,
  operation,
  makeValidationError,
  invoke,
  validateOutput,
  classifyError,
}: ProxyOptions<TDef, TValidationError>): Record<
  string,
  (args?: unknown) => AsyncResult<unknown, TValidationError | ProxyOperationError>
> {
  type ProxyError = TValidationError | ProxyOperationError;
  const proxy: Record<string, (args?: unknown) => AsyncResult<unknown, ProxyError>> = {};
  if (!defs) return proxy;

  for (const [name, def] of Object.entries(defs)) {
    const runPipeline = (currentInput: unknown): AsyncResult<unknown, ProxyError> =>
      validateStandardSchema(def.input, currentInput).flatMap(
        (inputResult): AsyncResult<unknown, ProxyError> => {
          if (inputResult.issues) {
            return ErrAsync(makeValidationError(name, "input", inputResult.issues));
          }
          // Send the ORIGINAL input — the worker parses on receive (D1).
          return fromPromise(
            invoke(name, currentInput),
            (error, defect) =>
              classifyError(error, name) ?? defect(new RuntimeClientError(operation, error)),
          ).flatMap((result) => {
            const outputSchema = validateOutput(def);
            if (!outputSchema) {
              return OkAsync(result);
            }
            return validateStandardSchema(outputSchema, result).flatMap((outputResult) =>
              outputResult.issues
                ? Err(makeValidationError(name, "output", outputResult.issues))
                : Ok(outputResult.value),
            );
          });
        },
      );

    proxy[name] = (args) => runPipeline(args);
  }

  return proxy;
}
