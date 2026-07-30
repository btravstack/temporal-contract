import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  AnyWorkflowDefinition,
  ContractDefinition,
  ErrorDefinition,
  SearchAttributeDefinition,
  SearchAttributeKindToType,
  SignalDefinition,
  SignalNamesOf,
  UpdateDefinition,
  UpdateNamesOf,
} from "@temporal-contract/contract";
import { TechnicalError, type ContractErrorUnion } from "@temporal-contract/contract/errors";
import { type Client, type WorkflowHandle, type WorkflowUpdateHandle } from "@temporalio/client";
import type {
  GetWorkflowHandleOptions,
  WorkflowSignalWithStartOptions,
  WorkflowStartOptions,
} from "@temporalio/client";
import { defineSearchAttributeKey, type TypedSearchAttributes } from "@temporalio/common";
import { type AsyncResult, type Result, Ok, Err, fromPromise } from "unthrown";

import {
  type WorkflowAlreadyStartedError,
  type WorkflowExecutionNotFoundError,
  type WorkflowFailedError,
  WorkflowNotInContractError,
  WorkflowValidationError,
  QueryValidationError,
  SignalValidationError,
  UpdateValidationError,
  RuntimeClientError,
} from "./errors.js";
import {
  chainInterceptors,
  type ClientCallError,
  type ClientInterceptor,
  type ClientInterceptorArgs,
} from "./interceptors.js";
import {
  assertNoDefect,
  classifyExecutionResultError,
  classifyHandleError,
  classifyStartError,
  makeAsyncResult,
  toTypedSearchAttributes,
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
 * the workflow's input schema and the named signal's input schema.
 */
export type TypedSignalWithStartOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
  TSignalName extends SignalNamesOf<TContract["workflows"][TWorkflowName]>,
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
 * plus the passthrough subset of Temporal's `WorkflowUpdateOptions`.
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
   * output schema.
   */
  result: () => AsyncResult<
    ClientInferOutput<TUpdate>,
    UpdateValidationError | WorkflowExecutionNotFoundError
  >;
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
   * Type-safe queries based on workflow definition with Result pattern
   * Each query returns AsyncResult<T, Error> instead of Promise<T>
   */
  queries: {
    [K in keyof ClientInferWorkflowQueries<TWorkflow>]: ClientInferWorkflowQueries<TWorkflow>[K] extends (
      ...args: infer Args
    ) => AsyncResult<infer R, Error>
      ? (...args: Args) => AsyncResult<R, QueryValidationError | WorkflowExecutionNotFoundError>
      : never;
  };

  /**
   * Type-safe signals based on workflow definition with Result pattern
   * Each signal returns AsyncResult<void, Error> instead of Promise<void>
   */
  signals: {
    [K in keyof ClientInferWorkflowSignals<TWorkflow>]: ClientInferWorkflowSignals<TWorkflow>[K] extends (
      ...args: infer Args
    ) => AsyncResult<void, Error>
      ? (...args: Args) => AsyncResult<void, SignalValidationError | WorkflowExecutionNotFoundError>
      : never;
  };

  /**
   * Type-safe updates based on workflow definition with Result pattern.
   * Each update starts the update AND waits for its result (Temporal's
   * `executeUpdate`); use {@link startUpdate} to obtain an update handle
   * without waiting for completion.
   */
  updates: {
    [K in keyof ClientInferWorkflowUpdates<TWorkflow>]: ClientInferWorkflowUpdates<TWorkflow>[K] extends (
      ...args: infer Args
    ) => AsyncResult<infer R, Error>
      ? (...args: Args) => AsyncResult<R, UpdateValidationError | WorkflowExecutionNotFoundError>
      : never;
  };

  /**
   * Start an update without waiting for its completion — Temporal's
   * `startUpdate` beside the `updates` map's execute-and-wait shape.
   * Returns a {@link TypedWorkflowUpdateHandle} whose `result()` parses the
   * outcome against the contract's output schema on receive. The `options`
   * parameter is omittable when the update's input schema accepts
   * `undefined` (e.g. an argument-less `defineUpdate({ output })`).
   */
  startUpdate: <TUpdateName extends UpdateNamesOf<TWorkflow>>(
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
    UpdateValidationError | WorkflowExecutionNotFoundError
  >;

  /**
   * Get workflow result with Result pattern. When the workflow declares
   * contract errors, a failed execution whose failure matches a declared
   * error surfaces as that typed error instead of the generic
   * {@link WorkflowFailedError}.
   */
  result: () => AsyncResult<
    ClientInferOutput<TWorkflow>,
    | WorkflowContractErrorsOf<TWorkflow>
    | WorkflowValidationError
    | WorkflowFailedError
    | WorkflowExecutionNotFoundError
  >;

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
 * `getHandle` deliberately keeps its own three-line lookup — it doesn't
 * accept `args` or `searchAttributes`, so it can't share this helper. The
 * call-specific extras (signal validation, post-call output parsing,
 * extended error classification) stay at the call site — those are the
 * differentiators that make each method distinct.
 */
async function resolveDefinitionAndValidateInput<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
>(
  contract: TContract,
  workflowName: TWorkflowName,
  workflowId: string,
  args: unknown,
  searchAttributes: Record<string, unknown> | undefined,
): Promise<
  Result<
    ResolvedWorkflow<TContract["workflows"][TWorkflowName]>,
    WorkflowNotInContractError | WorkflowValidationError
  >
> {
  const definition = contract.workflows[workflowName];
  if (!definition) {
    return Err(createWorkflowNotInContractError(workflowName, contract));
  }

  const inputResult = await definition.input["~standard"].validate(args);
  if (inputResult.issues) {
    return Err(new WorkflowValidationError(workflowName, "input", inputResult.issues, workflowId));
  }

  // `toTypedSearchAttributes` throws a `RuntimeClientError` on an undeclared
  // key or a value that doesn't match the declared kind — a technical
  // misconfiguration routed to the defect channel by the enclosing
  // `makeAsyncResult` work thunk (never a modeled Err).
  const typedSearchAttributes = toTypedSearchAttributes(definition, workflowName, searchAttributes);

  return Ok({
    definition: definition as TContract["workflows"][TWorkflowName],
    typedSearchAttributes,
  });
}

/**
 * Options for {@link TypedClient.create} — the single options-object shape
 * shared by the org's `Typed*.create()` factories.
 */
export type CreateClientOptions = {
  /** The underlying `@temporalio/client` `Client`. */
  client: Client;
  /**
   * Client-side interceptors wrapping `startWorkflow` / `executeWorkflow` /
   * `signalWithStart` and handle-level `signal` / `query` / `update`,
   * outermost-first, inherited by every contract-bound client handed out by
   * {@link TypedClient.for}. See {@link ClientInterceptor}.
   */
  interceptors?: readonly ClientInterceptor[];
};

/**
 * Connection-scoped root of the typed client surface.
 *
 * A client is a *connection*; a contract is a *schema*. `TypedClient` owns
 * the connection-lifetime concerns — the eager `ensureConnected()`, the
 * `@temporalio/client` capability check, the interceptor chain, and the
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
   * `raw` bypass contract validation and the interceptor chain.
   */
  readonly raw: Client;

  private readonly interceptors: readonly ClientInterceptor[];

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

  private constructor(client: Client, interceptors: readonly ClientInterceptor[]) {
    this.raw = client;
    this.interceptors = interceptors;
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
  static create({ client, interceptors }: CreateClientOptions): AsyncResult<TypedClient, never> {
    const work = async (): Promise<Result<TypedClient, never>> => {
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
          throw new TechnicalError("Failed to connect to Temporal server", error);
        }
      }

      return Ok(new TypedClient(client, interceptors ?? []));
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
   *       P.tag("@temporal-contract/WorkflowNotInContractError"),
   *       P.tag("@temporal-contract/WorkflowValidationError"),
   *       P.tag("@temporal-contract/WorkflowAlreadyStartedError"),
   *       P.tag("@temporal-contract/WorkflowFailedError"),
   *       P.tag("@temporal-contract/WorkflowExecutionNotFoundError"),
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
    const bound = new ContractClient(contract, this.raw, this.interceptors);
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
 * inherits its underlying `Client` and interceptors.
 */
export class ContractClient<TContract extends ContractDefinition> {
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

  /**
   * Constructed exclusively by {@link TypedClient.for}. Not part of the
   * public API — obtain instances via `typedClient.for(contract)`.
   *
   * @internal
   */
  constructor(
    private readonly contract: TContract,
    private readonly client: Client,
    private readonly interceptors: readonly ClientInterceptor[],
  ) {
    this.schedule = new TypedScheduleClient(contract, client.schedule);
  }

  /**
   * Start a workflow and return a typed handle with AsyncResult pattern
   *
   * @example
   * ```ts
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
   *       P.tag('@temporal-contract/WorkflowNotInContractError'),
   *       P.tag('@temporal-contract/WorkflowValidationError'),
   *       P.tag('@temporal-contract/WorkflowAlreadyStartedError'),
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
    type Ok = TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>;
    type Err = WorkflowNotInContractError | WorkflowValidationError | WorkflowAlreadyStartedError;
    const runPipeline = (currentInput: unknown): AsyncResult<Ok, Err> => {
      const work = async (): Promise<Result<Ok, Err>> => {
        const resolved = await resolveDefinitionAndValidateInput(
          this.contract,
          workflowName,
          temporalOptions.workflowId,
          currentInput,
          searchAttributes as Record<string, unknown> | undefined,
        );
        // The resolver only ever builds ok/err; assert away the impossible defect.
        assertNoDefect(resolved);
        if (resolved.isErr()) return Err(resolved.error);
        const { definition, typedSearchAttributes } = resolved.value;

        try {
          // Transmit the caller's ORIGINAL args — the input was validated
          // above (fail early), but the worker parses on receive, so the
          // parsed value must not cross the wire (D1). An omitted payload
          // travels as empty args, not `[undefined]`.
          const handle = await this.client.workflow.start(workflowName, {
            ...temporalOptions,
            taskQueue: this.contract.taskQueue,
            args: currentInput === undefined ? [] : [currentInput],
            ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
          });
          return Ok(
            this.createTypedHandle(handle, workflowName, definition, {
              runId: handle.firstExecutionRunId,
              firstExecutionRunId: handle.firstExecutionRunId,
            }) as Ok,
          );
        } catch (error) {
          const alreadyStarted = classifyStartError(error);
          if (alreadyStarted) return Err(alreadyStarted);
          // Unrecognized, technical failure — route to the defect channel.
          throw new RuntimeClientError("startWorkflow", error);
        }
      };
      return makeAsyncResult(work);
    };

    // Interceptors wrap the whole pipeline (outside validation), so a
    // patched input is validated exactly like the caller's original. Types
    // are erased through the chain and restored at this boundary.
    if (this.interceptors.length === 0) return runPipeline(args);
    return chainInterceptors(
      this.interceptors,
      {
        operation: "startWorkflow",
        workflowName,
        workflowId: temporalOptions.workflowId,
        input: args,
      } satisfies ClientInterceptorArgs,
      (current) => runPipeline(current.input) as AsyncResult<unknown, ClientCallError>,
    ) as AsyncResult<Ok, Err>;
  }

  /**
   * Send a signal to a workflow, starting it first if it doesn't already exist.
   *
   * Validates both halves of the call against the contract:
   * - `args` against the workflow's input schema
   * - `signalArgs` against the named signal's input schema
   *
   * Returns a `TypedWorkflowHandleWithSignaledRunId` — the same shape as
   * `startWorkflow`'s handle, plus a `signaledRunId` field for correlating
   * the signal with the (possibly pre-existing) workflow execution chain.
   *
   * @example
   * ```ts
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
   *     matcher.with(
   *       P.tag('@temporal-contract/WorkflowNotInContractError'),
   *       P.tag('@temporal-contract/WorkflowValidationError'),
   *       P.tag('@temporal-contract/SignalValidationError'),
   *       P.tag('@temporal-contract/WorkflowAlreadyStartedError'),
   *       (error) => console.error('signalWithStart failed', error),
   *     ),
   *   defect: (cause) => console.error('unexpected failure', cause),
   * });
   * ```
   */
  signalWithStart<
    TWorkflowName extends keyof TContract["workflows"] & string,
    TSignalName extends SignalNamesOf<TContract["workflows"][TWorkflowName]>,
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
    type Ok = TypedWorkflowHandleWithSignaledRunId<TContract["workflows"][TWorkflowName]>;
    type Err =
      | WorkflowNotInContractError
      | WorkflowValidationError
      | SignalValidationError
      | WorkflowAlreadyStartedError;

    const runPipeline = (
      currentInput: unknown,
      currentSignalInput: unknown,
    ): AsyncResult<Ok, Err> => {
      const work = async (): Promise<Result<Ok, Err>> => {
        const resolved = await resolveDefinitionAndValidateInput(
          this.contract,
          workflowName,
          temporalOptions.workflowId,
          currentInput,
          searchAttributes as Record<string, unknown> | undefined,
        );
        // The resolver only ever builds ok/err; assert away the impossible defect.
        assertNoDefect(resolved);
        if (resolved.isErr()) return Err(resolved.error);
        const { definition, typedSearchAttributes } = resolved.value;

        // Validate signal input — call-site-specific, kept inline. Like the
        // workflow input, the parsed value is discarded: the signal handler
        // parses on receive, so the original signal args go over the wire.
        const signalDef = (definition.signals as Record<string, SignalDefinition> | undefined)?.[
          signalName
        ];
        if (!signalDef) {
          // Type-level constraint should already prevent this; defensive for
          // raw-call / union-typed-name corner cases.
          return Err(
            new SignalValidationError(signalName, [
              {
                message: `Signal "${signalName}" is not declared on workflow "${workflowName}".`,
              },
            ]),
          );
        }
        const signalInputResult = await signalDef.input["~standard"].validate(currentSignalInput);
        if (signalInputResult.issues) {
          return Err(new SignalValidationError(signalName, signalInputResult.issues));
        }

        try {
          const handle = await this.client.workflow.signalWithStart(workflowName, {
            ...temporalOptions,
            taskQueue: this.contract.taskQueue,
            args: currentInput === undefined ? [] : [currentInput],
            signal: signalName,
            // An omitted signal payload travels as empty signalArgs. The
            // cast collapses the `[] | [unknown]` union the SDK's overload
            // inference can't split.
            signalArgs: (currentSignalInput === undefined ? [] : [currentSignalInput]) as unknown[],
            ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
          });
          const typed = this.createTypedHandle(
            handle,
            workflowName,
            definition,
          ) as TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>;
          return Ok({ ...typed, signaledRunId: handle.signaledRunId } as Ok);
        } catch (error) {
          const alreadyStarted = classifyStartError(error);
          if (alreadyStarted) return Err(alreadyStarted);
          // Unrecognized, technical failure — route to the defect channel.
          throw new RuntimeClientError("signalWithStart", error);
        }
      };
      return makeAsyncResult(work);
    };

    if (this.interceptors.length === 0) return runPipeline(args, signalArgs);
    return chainInterceptors(
      this.interceptors,
      {
        operation: "signalWithStart",
        workflowName,
        workflowId: temporalOptions.workflowId,
        input: args,
        signalName,
        signalInput: signalArgs,
      } satisfies ClientInterceptorArgs,
      (current) =>
        runPipeline(
          current.input,
          (current as { signalInput: unknown }).signalInput,
        ) as AsyncResult<unknown, ClientCallError>,
    ) as AsyncResult<Ok, Err>;
  }

  /**
   * Execute a workflow (start and wait for result) with AsyncResult pattern
   *
   * @example
   * ```ts
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
   *     matcher.with(
   *       P.tag('@temporal-contract/ContractError'),
   *       P.tag('@temporal-contract/WorkflowNotInContractError'),
   *       P.tag('@temporal-contract/WorkflowValidationError'),
   *       P.tag('@temporal-contract/WorkflowAlreadyStartedError'),
   *       P.tag('@temporal-contract/WorkflowFailedError'),
   *       P.tag('@temporal-contract/WorkflowExecutionNotFoundError'),
   *       (error) => console.error('Processing failed:', error),
   *     ),
   *   defect: (cause) => console.error('Unexpected failure:', cause),
   * });
   * ```
   */
  executeWorkflow<TWorkflowName extends keyof TContract["workflows"] & string>(
    workflowName: TWorkflowName,
    options: TypedWorkflowStartOptions<TContract, TWorkflowName>,
  ): AsyncResult<
    ClientInferOutput<TContract["workflows"][TWorkflowName]>,
    | WorkflowContractErrorsOf<TContract["workflows"][TWorkflowName]>
    | WorkflowNotInContractError
    | WorkflowValidationError
    | WorkflowAlreadyStartedError
    | WorkflowFailedError
    | WorkflowExecutionNotFoundError
  > {
    // Widen once at the boundary — same rationale as `startWorkflow`.
    const { args, searchAttributes, ...temporalOptions } = options as Omit<
      WorkflowStartOptions,
      "taskQueue" | "args" | "searchAttributes" | "typedSearchAttributes"
    > & { args?: unknown; searchAttributes?: Record<string, unknown> };
    type Ok = ClientInferOutput<TContract["workflows"][TWorkflowName]>;
    type Err =
      | WorkflowContractErrorsOf<TContract["workflows"][TWorkflowName]>
      | WorkflowNotInContractError
      | WorkflowValidationError
      | WorkflowAlreadyStartedError
      | WorkflowFailedError
      | WorkflowExecutionNotFoundError;
    const runPipeline = (currentInput: unknown): AsyncResult<Ok, Err> => {
      const work = async (): Promise<Result<Ok, Err>> => {
        const resolved = await resolveDefinitionAndValidateInput(
          this.contract,
          workflowName,
          temporalOptions.workflowId,
          currentInput,
          searchAttributes as Record<string, unknown> | undefined,
        );
        // The resolver only ever builds ok/err; assert away the impossible defect.
        assertNoDefect(resolved);
        if (resolved.isErr()) return Err(resolved.error);
        const { definition, typedSearchAttributes } = resolved.value;

        try {
          // Transmit the caller's ORIGINAL args (validated above, parsed by
          // the worker on receive — D1).
          const result = await this.client.workflow.execute(workflowName, {
            ...temporalOptions,
            taskQueue: this.contract.taskQueue,
            args: currentInput === undefined ? [] : [currentInput],
            ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
          });

          // Output parsing runs *after* the Temporal call returns — kept
          // inline because it's specific to executeWorkflow's start-and-wait
          // shape; the helper only handles pre-call concerns. This is the
          // RECEIVING side of the result boundary: the worker validated and
          // transmitted its original return value, so the parse (and any
          // schema transform) happens exactly once, here.
          const outputResult = await definition.output["~standard"].validate(result);
          if (outputResult.issues) {
            return Err(
              new WorkflowValidationError(
                workflowName,
                "output",
                outputResult.issues,
                temporalOptions.workflowId,
              ),
            );
          }

          return Ok(outputResult.value as Ok);
        } catch (error) {
          // executeWorkflow combines start + result, so it can surface any
          // of the discriminated kinds: the start-phase classification
          // first, then the shared rehydrate-then-classify result tail.
          const alreadyStarted = classifyStartError(error);
          if (alreadyStarted) return Err(alreadyStarted);
          const classified = await classifyExecutionResultError(
            definition,
            error,
            temporalOptions.workflowId,
          );
          if (classified) return Err(classified as Err);
          // Unrecognized, technical failure — route to the defect channel.
          throw new RuntimeClientError("executeWorkflow", error);
        }
      };
      return makeAsyncResult(work);
    };

    if (this.interceptors.length === 0) return runPipeline(args);
    return chainInterceptors(
      this.interceptors,
      {
        operation: "executeWorkflow",
        workflowName,
        workflowId: temporalOptions.workflowId,
        input: args,
      } satisfies ClientInterceptorArgs,
      (current) => runPipeline(current.input) as AsyncResult<unknown, ClientCallError>,
    ) as AsyncResult<Ok, Err>;
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
      workflowName,
      workflowId: workflowHandle.workflowId,
      interceptors: this.interceptors,
      makeValidationError: (name, direction, issues) =>
        new QueryValidationError(name, direction, issues),
      invoke: (name, input) =>
        input === undefined ? workflowHandle.query(name) : workflowHandle.query(name, input),
      validateOutput: (def) => def.output,
    }) as TypedWorkflowHandle<TWorkflow>["queries"];

    const signals = buildValidatedProxy({
      defs: definition.signals,
      operation: "signal",
      workflowName,
      workflowId: workflowHandle.workflowId,
      interceptors: this.interceptors,
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
    }) as TypedWorkflowHandle<TWorkflow>["signals"];

    const updates = buildValidatedProxy({
      defs: definition.updates,
      operation: "update",
      workflowName,
      workflowId: workflowHandle.workflowId,
      interceptors: this.interceptors,
      makeValidationError: (name, direction, issues) =>
        new UpdateValidationError(name, direction, issues),
      invoke: (name, input) =>
        workflowHandle.executeUpdate(name, {
          args: (input === undefined ? [] : [input]) as [unknown],
        }),
      validateOutput: (def) => def.output,
    }) as TypedWorkflowHandle<TWorkflow>["updates"];

    type StartUpdateErr = UpdateValidationError | WorkflowExecutionNotFoundError;

    const wrapUpdateHandle = (
      updateHandle: WorkflowUpdateHandle<unknown>,
      updateName: string,
      updateDef: UpdateDefinition,
    ): TypedWorkflowUpdateHandle<UpdateDefinition> => ({
      updateId: updateHandle.updateId,
      workflowId: updateHandle.workflowId,
      workflowRunId: updateHandle.workflowRunId,
      result: (): AsyncResult<unknown, StartUpdateErr> => {
        const work = async (): Promise<Result<unknown, StartUpdateErr>> => {
          try {
            const raw = await updateHandle.result();
            // Receive side of the update-result boundary: the handler
            // transmitted its original return value; parse it here (D1).
            const outputResult = await updateDef.output["~standard"].validate(raw);
            if (outputResult.issues) {
              return Err(new UpdateValidationError(updateName, "output", outputResult.issues));
            }
            return Ok(outputResult.value);
          } catch (error) {
            const notFound = classifyHandleError(error, updateHandle.workflowId);
            if (notFound) return Err(notFound);
            // Unrecognized, technical failure — route to the defect channel.
            throw new RuntimeClientError("update.result", error);
          }
        };
        return makeAsyncResult(work);
      },
    });

    const startUpdate = (
      updateName: string,
      options?: { args?: unknown; updateId?: string; waitForStage?: "ACCEPTED" },
    ): AsyncResult<unknown, StartUpdateErr> => {
      const runPipeline = (currentInput: unknown): AsyncResult<unknown, StartUpdateErr> => {
        const work = async (): Promise<Result<unknown, StartUpdateErr>> => {
          const updateDef = (definition.updates as Record<string, UpdateDefinition> | undefined)?.[
            updateName
          ];
          if (!updateDef) {
            // Type-level constraint should already prevent this; defensive
            // for raw-call / union-typed-name corner cases.
            return Err(
              new UpdateValidationError(updateName, "input", [
                {
                  message: `Update "${updateName}" is not declared on workflow "${workflowName}".`,
                },
              ]),
            );
          }
          const inputResult = await updateDef.input["~standard"].validate(currentInput);
          if (inputResult.issues) {
            return Err(new UpdateValidationError(updateName, "input", inputResult.issues));
          }

          try {
            // Send the ORIGINAL input — the update handler parses on
            // receive (D1). An omitted payload travels as empty args.
            const updateHandle = await workflowHandle.startUpdate(updateName, {
              args: (currentInput === undefined ? [] : [currentInput]) as [unknown],
              waitForStage: options?.waitForStage ?? "ACCEPTED",
              ...(options?.updateId !== undefined ? { updateId: options.updateId } : {}),
            });
            return Ok(wrapUpdateHandle(updateHandle, updateName, updateDef));
          } catch (error) {
            const notFound = classifyHandleError(error, workflowHandle.workflowId);
            if (notFound) return Err(notFound);
            // Unrecognized, technical failure — route to the defect channel.
            throw new RuntimeClientError("startUpdate", error);
          }
        };
        return makeAsyncResult(work);
      };

      // Interceptors wrap the whole pipeline (outside validation), same
      // `update` operation as the execute-and-wait `updates` map.
      if (this.interceptors.length === 0) return runPipeline(options?.args);
      return chainInterceptors(
        this.interceptors,
        {
          operation: "update",
          workflowName,
          workflowId: workflowHandle.workflowId,
          name: updateName,
          input: options?.args,
        } satisfies ClientInterceptorArgs,
        (current) => runPipeline(current.input) as AsyncResult<unknown, ClientCallError>,
      ) as AsyncResult<unknown, StartUpdateErr>;
    };

    return {
      workflowId: workflowHandle.workflowId,
      runId: ids.runId,
      firstExecutionRunId: ids.firstExecutionRunId,
      queries,
      signals,
      updates,
      startUpdate: startUpdate as TypedWorkflowHandle<TWorkflow>["startUpdate"],
      result: (): AsyncResult<
        ClientInferOutput<TWorkflow>,
        | WorkflowContractErrorsOf<TWorkflow>
        | WorkflowValidationError
        | WorkflowFailedError
        | WorkflowExecutionNotFoundError
      > => {
        type Ok = ClientInferOutput<TWorkflow>;
        type Err =
          | WorkflowContractErrorsOf<TWorkflow>
          | WorkflowValidationError
          | WorkflowFailedError
          | WorkflowExecutionNotFoundError;
        const work = async (): Promise<Result<Ok, Err>> => {
          try {
            const result = await workflowHandle.result();
            const outputResult = await definition.output["~standard"].validate(result);
            if (outputResult.issues) {
              return Err(
                new WorkflowValidationError(
                  workflowName,
                  "output",
                  outputResult.issues,
                  workflowHandle.workflowId,
                ),
              );
            }
            return Ok(outputResult.value as Ok);
          } catch (error) {
            // Shared rehydrate-then-classify tail: a failure matching one of
            // the workflow's declared contract errors rehydrates into the
            // typed error; everything else falls through to the generic
            // classification.
            const classified = await classifyExecutionResultError(
              definition,
              error,
              workflowHandle.workflowId,
            );
            if (classified) return Err(classified as Err);
            // Unrecognized, technical failure — route to the defect channel.
            throw new RuntimeClientError("result", error);
          }
        };
        return makeAsyncResult(work);
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

type ProxyOptions<TDef extends DefWithInput, TValidationError extends Error> = {
  readonly defs: Record<string, TDef> | undefined;
  readonly operation: "signal" | "query" | "update";
  /** Contract workflow name of the handle — surfaced to interceptors. */
  readonly workflowName: string;
  /**
   * Workflow ID of the handle these proxies bind to. Used by
   * {@link classifyHandleError} to surface
   * {@link WorkflowExecutionNotFoundError} with the targeted ID even when
   * Temporal's error doesn't carry it.
   */
  readonly workflowId: string;
  /** Client interceptors wrapping every invocation, outermost-first. */
  readonly interceptors: readonly ClientInterceptor[];
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
};

/**
 * Build a `{ name: (args) => AsyncResult<...> }` proxy for a contract's
 * queries/signals/updates. The three call sites differ only in how they
 * invoke Temporal and whether they parse output, so the shared
 * input-validate → invoke(original) → output-parse → wrap-Result pipeline
 * lives here once. Per the wire-format contract (D1), input validation only
 * gates the call — the original value is transmitted and the worker parses
 * it — while the result is parsed here on the receiving side.
 */
function buildValidatedProxy<TDef extends DefWithInput, TValidationError extends Error>({
  defs,
  operation,
  workflowName,
  workflowId,
  interceptors,
  makeValidationError,
  invoke,
  validateOutput,
}: ProxyOptions<TDef, TValidationError>): Record<
  string,
  (args?: unknown) => AsyncResult<unknown, TValidationError | WorkflowExecutionNotFoundError>
> {
  type ProxyError = TValidationError | WorkflowExecutionNotFoundError;
  const proxy: Record<string, (args?: unknown) => AsyncResult<unknown, ProxyError>> = {};
  if (!defs) return proxy;

  for (const [name, def] of Object.entries(defs)) {
    const runPipeline = (currentInput: unknown): AsyncResult<unknown, ProxyError> => {
      const work = async (): Promise<Result<unknown, ProxyError>> => {
        const inputResult = await def.input["~standard"].validate(currentInput);
        if (inputResult.issues) {
          return Err(makeValidationError(name, "input", inputResult.issues));
        }

        try {
          // Send the ORIGINAL input — the worker parses on receive (D1).
          const result = await invoke(name, currentInput);
          const outputSchema = validateOutput(def);
          if (!outputSchema) {
            return Ok(result);
          }
          const outputResult = await outputSchema["~standard"].validate(result);
          if (outputResult.issues) {
            return Err(makeValidationError(name, "output", outputResult.issues));
          }
          return Ok(outputResult.value);
        } catch (error) {
          const notFound = classifyHandleError(error, workflowId);
          if (notFound) return Err(notFound);
          // Unrecognized, technical failure — route to the defect channel.
          throw new RuntimeClientError(operation, error);
        }
      };
      return makeAsyncResult(work);
    };

    proxy[name] = (args) => {
      // Interceptors wrap the whole pipeline (outside validation), so a
      // patched input is validated exactly like the caller's original.
      if (interceptors.length === 0) return runPipeline(args);
      return chainInterceptors(
        interceptors,
        {
          operation,
          workflowName,
          workflowId,
          name,
          input: args,
        } satisfies ClientInterceptorArgs,
        (current) => runPipeline(current.input) as AsyncResult<unknown, ClientCallError>,
      ) as AsyncResult<unknown, ProxyError>;
    };
  }

  return proxy;
}
