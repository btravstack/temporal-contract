import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  AnyWorkflowDefinition,
  ContractDefinition,
  ErrorDefinition,
  SearchAttributeDefinition,
  SearchAttributeKindToType,
  SignalDefinition,
  SignalNamesOf,
} from "@temporal-contract/contract";
import { TechnicalError, type ContractErrorUnion } from "@temporal-contract/contract/errors";
import { type Client, type WorkflowHandle } from "@temporalio/client";
import type { WorkflowSignalWithStartOptions, WorkflowStartOptions } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { WorkflowFailedError as TemporalWorkflowFailedError } from "@temporalio/client";
import { defineSearchAttributeKey, type TypedSearchAttributes } from "@temporalio/common";
import { WorkflowNotFoundError as TemporalWorkflowNotFoundError } from "@temporalio/common";
import { type AsyncResult, type Result, Ok, Err, fromPromise } from "unthrown";

import {
  type TemporalFailure,
  WorkflowAlreadyStartedError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
  WorkflowNotFoundError,
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
  classifyHandleError,
  classifyResultError,
  classifyStartError,
  makeAsyncResult,
  rehydrateWorkflowContractError,
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

export type TypedWorkflowStartOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
> = Omit<
  WorkflowStartOptions,
  "taskQueue" | "args" | "searchAttributes" | "typedSearchAttributes"
> & {
  args: ClientInferInput<TContract["workflows"][TWorkflowName]>;
  /**
   * Indexed search attributes for the started workflow. Keys and value types
   * are constrained to those declared on the workflow's contract via
   * `defineSearchAttribute`. Translated to Temporal's `typedSearchAttributes`
   * before the start request is dispatched.
   */
  searchAttributes?: TypedSearchAttributeMap<TContract["workflows"][TWorkflowName]>;
};

/**
 * Options for {@link TypedClient.signalWithStart} — typed against both the
 * workflow's input schema and the named signal's input schema.
 */
export type TypedSignalWithStartOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
  TSignalName extends SignalNamesOf<TContract["workflows"][TWorkflowName]>,
> = Omit<
  WorkflowSignalWithStartOptions,
  "taskQueue" | "args" | "signal" | "signalArgs" | "searchAttributes" | "typedSearchAttributes"
> & {
  args: ClientInferInput<TContract["workflows"][TWorkflowName]>;
  signalName: TSignalName;
  signalArgs: TContract["workflows"][TWorkflowName]["signals"][TSignalName] extends SignalDefinition
    ? ClientInferInput<TContract["workflows"][TWorkflowName]["signals"][TSignalName]>
    : never;
  /**
   * Indexed search attributes for the started workflow. Keys and value types
   * are constrained to those declared on the workflow's contract via
   * `defineSearchAttribute`. Translated to Temporal's `typedSearchAttributes`
   * before the signalWithStart request is dispatched.
   */
  searchAttributes?: TypedSearchAttributeMap<TContract["workflows"][TWorkflowName]>;
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
  workflowId: string;

  /**
   * Type-safe queries based on workflow definition with Result pattern
   * Each query returns AsyncResult<T, Error> instead of Promise<T>
   */
  queries: {
    [K in keyof ClientInferWorkflowQueries<TWorkflow>]: ClientInferWorkflowQueries<TWorkflow>[K] extends (
      ...args: infer Args
    ) => AsyncResult<infer R, Error>
      ? (
          ...args: Args
        ) => AsyncResult<
          R,
          QueryValidationError | WorkflowExecutionNotFoundError | RuntimeClientError
        >
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
      ? (
          ...args: Args
        ) => AsyncResult<
          void,
          SignalValidationError | WorkflowExecutionNotFoundError | RuntimeClientError
        >
      : never;
  };

  /**
   * Type-safe updates based on workflow definition with Result pattern
   * Each update returns AsyncResult<T, Error> instead of Promise<T>
   */
  updates: {
    [K in keyof ClientInferWorkflowUpdates<TWorkflow>]: ClientInferWorkflowUpdates<TWorkflow>[K] extends (
      ...args: infer Args
    ) => AsyncResult<infer R, Error>
      ? (
          ...args: Args
        ) => AsyncResult<
          R,
          UpdateValidationError | WorkflowExecutionNotFoundError | RuntimeClientError
        >
      : never;
  };

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
    | RuntimeClientError
  >;

  /**
   * Terminate workflow with Result pattern
   */
  terminate: (
    reason?: string,
  ) => AsyncResult<void, WorkflowExecutionNotFoundError | RuntimeClientError>;

  /**
   * Cancel workflow with Result pattern
   */
  cancel: () => AsyncResult<void, WorkflowExecutionNotFoundError | RuntimeClientError>;

  /**
   * Get workflow execution description including status and metadata
   */
  describe: () => AsyncResult<
    Awaited<ReturnType<WorkflowHandle["describe"]>>,
    WorkflowExecutionNotFoundError | RuntimeClientError
  >;

  /**
   * Fetch the workflow execution history
   */
  fetchHistory: () => AsyncResult<
    Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>,
    WorkflowExecutionNotFoundError | RuntimeClientError
  >;
};

/**
 * Result of {@link resolveDefinitionAndValidateInput} — the contract-side
 * pre-call ritual the start/signal-with-start/execute methods share. Holds
 * the resolved workflow definition, the schema-validated input, and the
 * translated typed search attributes (or `undefined` when the workflow
 * declared none / the caller passed none).
 */
type ResolvedWorkflow<TWorkflow extends AnyWorkflowDefinition> = {
  definition: TWorkflow;
  validatedInput: unknown;
  typedSearchAttributes: TypedSearchAttributes | undefined;
};

/**
 * Shared pre-call ritual for the three contract-driven entry points that
 * actually start a workflow (`startWorkflow`, `signalWithStart`,
 * `executeWorkflow`):
 *
 *   1. Look up the workflow definition on the contract.
 *   2. Surface a `WorkflowNotFoundError` if absent.
 *   3. Validate `args` against the workflow's input schema.
 *   4. Surface a `WorkflowValidationError` if validation fails.
 *   5. Translate any caller-supplied `searchAttributes` into Temporal's
 *      `TypedSearchAttributes` shape (or `undefined`).
 *
 * `getHandle` deliberately keeps its own three-line lookup — it doesn't
 * accept `args` or `searchAttributes`, so it can't share this helper. The
 * call-specific extras (signal validation, post-call output validation,
 * extended error classification) stay at the call site — those are the
 * differentiators that make each method distinct.
 */
async function resolveDefinitionAndValidateInput<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
>(
  contract: TContract,
  workflowName: TWorkflowName,
  args: unknown,
  searchAttributes: Record<string, unknown> | undefined,
): Promise<
  Result<
    ResolvedWorkflow<TContract["workflows"][TWorkflowName]>,
    WorkflowNotFoundError | WorkflowValidationError | RuntimeClientError
  >
> {
  const definition = contract.workflows[workflowName];
  if (!definition) {
    return Err(createWorkflowNotFoundError(workflowName, contract));
  }

  const inputResult = await definition.input["~standard"].validate(args);
  if (inputResult.issues) {
    return Err(createWorkflowValidationError(workflowName, "input", inputResult.issues));
  }

  const searchAttributesResult = toTypedSearchAttributes(
    definition,
    workflowName,
    searchAttributes,
  );
  // `toTypedSearchAttributes` only ever builds ok/err; assert away the
  // impossible defect so `.error` / `.value` narrow cleanly.
  assertNoDefect(searchAttributesResult);
  if (searchAttributesResult.isErr()) return Err(searchAttributesResult.error);
  const typedSearchAttributes = searchAttributesResult.value;

  return Ok({
    definition: definition as TContract["workflows"][TWorkflowName],
    validatedInput: inputResult.value,
    typedSearchAttributes,
  });
}

/**
 * Options for {@link TypedClient.create} — the single options-object shape
 * shared by the org's `Typed*.create()` factories.
 */
export type CreateTypedClientOptions<TContract extends ContractDefinition> = {
  /** The contract this client is typed against. */
  contract: TContract;
  /** The underlying `@temporalio/client` `Client`. */
  client: Client;
  /**
   * Client-side interceptors wrapping `startWorkflow` / `executeWorkflow` /
   * `signalWithStart` and handle-level `signal` / `query` / `update`,
   * outermost-first. See {@link ClientInterceptor}.
   */
  interceptors?: readonly ClientInterceptor[];
};

/**
 * Typed Temporal client with unthrown Result/AsyncResult pattern based on a contract
 *
 * Provides type-safe methods to start and execute workflows
 * defined in the contract, with explicit error handling using Result pattern.
 */
export class TypedClient<TContract extends ContractDefinition> {
  /**
   * Typed wrapper around Temporal's `client.schedule.create(...)` and
   * related lifecycle methods. Fires the underlying `startWorkflow` action
   * with args validated against the contract's input schema.
   *
   * **Requires `@temporalio/client` 1.16+.** The Schedule API was added in
   * 1.16; on older versions this property is unset and any access throws.
   * The package's peer dep allows the whole `^1` range to stay permissive
   * about the installed Temporal version, so consumers on < 1.16 who never
   * touch schedules keep working — the constructor below fails fast with a
   * clear message for anyone who does reach for the Schedule API too early.
   *
   * @example
   * ```ts
   * const result = await client.schedule.create("processOrder", {
   *   scheduleId: "daily-sweep",
   *   spec: { cronExpressions: ["0 2 * * *"] },
   *   args: { orderId: "sweep" },
   * });
   *
   * await result.match({
   *   ok: async (handle) => { await handle.pause("maintenance"); },
   *   err: (error) => console.error("schedule create failed", error),
   *   defect: (cause) => console.error("unexpected failure", cause),
   * });
   * ```
   */
  readonly schedule: TypedScheduleClient<TContract>;

  private constructor(
    private readonly contract: TContract,
    private readonly client: Client,
    private readonly interceptors: readonly ClientInterceptor[],
  ) {
    // `client.schedule` is the ScheduleClient wired into Temporal's
    // top-level `Client` since 1.16. The peer dep allows all of `^1`, so a
    // consumer can be on an older version — fail early with a clear message
    // rather than crashing later with a confusing
    // `Cannot read properties of undefined`.
    if (!client.schedule) {
      throw new Error(
        "TypedClient requires @temporalio/client >= 1.16 (the Schedule API was added in 1.16). " +
          "Found a Client instance without a `schedule` property — please upgrade.",
      );
    }
    this.schedule = new TypedScheduleClient(contract, client.schedule);
  }

  /**
   * Create a typed Temporal client with unthrown pattern from a contract.
   *
   * Returns `AsyncResult<TypedClient, TechnicalError>` — errors-as-values
   * from the very first call, matching the org-wide `Typed*.create()`
   * factory shape (amqp-contract's `TypedAmqpClient.create`). Modeled
   * failures on the `Err` channel:
   *
   * - the underlying `Client` lacks the Schedule API
   *   (`@temporalio/client` < 1.16);
   * - the connection cannot be established (when the client's connection
   *   exposes `ensureConnected`, it is awaited eagerly so a bad
   *   address/namespace surfaces here instead of on the first operation).
   *
   * @example
   * ```ts
   * const connection = await Connection.connect();
   * const temporalClient = new Client({ connection });
   * const clientResult = await TypedClient.create({
   *   contract: myContract,
   *   client: temporalClient,
   * });
   * if (clientResult.isErr()) {
   *   console.error('client setup failed', clientResult.error);
   *   return;
   * }
   * const client = clientResult.value;
   *
   * const result = await client.executeWorkflow('processOrder', {
   *   workflowId: 'order-123',
   *   args: { ... },
   * });
   * ```
   */
  static create<TContract extends ContractDefinition>({
    contract,
    client,
    interceptors,
  }: CreateTypedClientOptions<TContract>): AsyncResult<TypedClient<TContract>, TechnicalError> {
    const work = async (): Promise<Result<TypedClient<TContract>, TechnicalError>> => {
      let instance: TypedClient<TContract>;
      try {
        instance = new TypedClient(contract, client, interceptors ?? []);
      } catch (error) {
        return Err(
          new TechnicalError(
            error instanceof Error ? error.message : "Failed to create TypedClient",
            error,
          ),
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
          return Err(new TechnicalError("Failed to connect to Temporal server", error));
        }
      }

      return Ok(instance);
    };
    return makeAsyncResult(work);
  }

  /**
   * Create a typed client synchronously, throwing on failure — the
   * pre-AsyncResult behavior.
   *
   * @deprecated Use {@link TypedClient.create}, which returns
   * `AsyncResult<TypedClient, TechnicalError>` and also validates the
   * connection eagerly. This throwing alias exists to ease migration and
   * will be removed in a future major.
   */
  static createOrThrow<TContract extends ContractDefinition>(
    contract: TContract,
    client: Client,
    interceptors?: readonly ClientInterceptor[],
  ): TypedClient<TContract> {
    return new TypedClient(contract, client, interceptors ?? []);
  }

  /**
   * Start a workflow and return a typed handle with AsyncResult pattern
   *
   * @example
   * ```ts
   * const handleResult = await client.startWorkflow('processOrder', {
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
   *   err: (error) => console.error('Failed to start:', error),
   *   defect: (cause) => console.error('Unexpected failure:', cause),
   * });
   * ```
   */
  startWorkflow<TWorkflowName extends keyof TContract["workflows"] & string>(
    workflowName: TWorkflowName,
    {
      args,
      searchAttributes,
      ...temporalOptions
    }: TypedWorkflowStartOptions<TContract, TWorkflowName>,
  ): AsyncResult<
    TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>,
    | WorkflowNotFoundError
    | WorkflowValidationError
    | WorkflowAlreadyStartedError
    | RuntimeClientError
  > {
    type Ok = TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>;
    type Err =
      | WorkflowNotFoundError
      | WorkflowValidationError
      | WorkflowAlreadyStartedError
      | RuntimeClientError;
    const runPipeline = (currentInput: unknown): AsyncResult<Ok, Err> => {
      const work = async (): Promise<Result<Ok, Err>> => {
        const resolved = await resolveDefinitionAndValidateInput(
          this.contract,
          workflowName,
          currentInput,
          searchAttributes as Record<string, unknown> | undefined,
        );
        // The resolver only ever builds ok/err; assert away the impossible defect.
        assertNoDefect(resolved);
        if (resolved.isErr()) return Err(resolved.error);
        const { definition, validatedInput, typedSearchAttributes } = resolved.value;

        try {
          const handle = await this.client.workflow.start(workflowName, {
            ...temporalOptions,
            taskQueue: this.contract.taskQueue,
            args: [validatedInput],
            ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
          });
          return Ok(this.createTypedHandle(handle, workflowName, definition) as Ok);
        } catch (error) {
          return Err(classifyStartError("startWorkflow", error));
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
   * const result = await client.signalWithStart('processOrder', {
   *   workflowId: 'order-123',
   *   args: { orderId: 'ORD-123', customerId: 'CUST-1' },
   *   signalName: 'cancel',
   *   signalArgs: { reason: 'duplicate' },
   * });
   *
   * await result.match({
   *   ok: (handle) => console.log('signaled run', handle.signaledRunId),
   *   err: (error) => console.error('signalWithStart failed', error),
   *   defect: (cause) => console.error('unexpected failure', cause),
   * });
   * ```
   */
  signalWithStart<
    TWorkflowName extends keyof TContract["workflows"] & string,
    TSignalName extends SignalNamesOf<TContract["workflows"][TWorkflowName]>,
  >(
    workflowName: TWorkflowName,
    {
      args,
      signalName,
      signalArgs,
      searchAttributes,
      ...temporalOptions
    }: TypedSignalWithStartOptions<TContract, TWorkflowName, TSignalName>,
  ): AsyncResult<
    TypedWorkflowHandleWithSignaledRunId<TContract["workflows"][TWorkflowName]>,
    | WorkflowNotFoundError
    | WorkflowValidationError
    | SignalValidationError
    | WorkflowAlreadyStartedError
    | RuntimeClientError
  > {
    type Ok = TypedWorkflowHandleWithSignaledRunId<TContract["workflows"][TWorkflowName]>;
    type Err =
      | WorkflowNotFoundError
      | WorkflowValidationError
      | SignalValidationError
      | WorkflowAlreadyStartedError
      | RuntimeClientError;

    const runPipeline = (
      currentInput: unknown,
      currentSignalInput: unknown,
    ): AsyncResult<Ok, Err> => {
      const work = async (): Promise<Result<Ok, Err>> => {
        const resolved = await resolveDefinitionAndValidateInput(
          this.contract,
          workflowName,
          currentInput,
          searchAttributes as Record<string, unknown> | undefined,
        );
        // The resolver only ever builds ok/err; assert away the impossible defect.
        assertNoDefect(resolved);
        if (resolved.isErr()) return Err(resolved.error);
        const { definition, validatedInput, typedSearchAttributes } = resolved.value;

        // Validate signal input — call-site-specific, kept inline.
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
            args: [validatedInput],
            signal: signalName,
            signalArgs: [signalInputResult.value],
            ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
          });
          const typed = this.createTypedHandle(
            handle,
            workflowName,
            definition,
          ) as TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>;
          return Ok({ ...typed, signaledRunId: handle.signaledRunId } as Ok);
        } catch (error) {
          return Err(classifyStartError("signalWithStart", error));
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
   * const result = await client.executeWorkflow('processOrder', {
   *   workflowId: 'order-123',
   *   args: { orderId: 'ORD-123' },
   *   workflowExecutionTimeout: '1 day',
   *   retry: { maximumAttempts: 3 },
   * });
   *
   * await result.match({
   *   ok: (output) => console.log('Order processed:', output.status),
   *   err: (error) => console.error('Processing failed:', error),
   *   defect: (cause) => console.error('Unexpected failure:', cause),
   * });
   * ```
   */
  executeWorkflow<TWorkflowName extends keyof TContract["workflows"] & string>(
    workflowName: TWorkflowName,
    {
      args,
      searchAttributes,
      ...temporalOptions
    }: TypedWorkflowStartOptions<TContract, TWorkflowName>,
  ): AsyncResult<
    ClientInferOutput<TContract["workflows"][TWorkflowName]>,
    | WorkflowContractErrorsOf<TContract["workflows"][TWorkflowName]>
    | WorkflowNotFoundError
    | WorkflowValidationError
    | WorkflowAlreadyStartedError
    | WorkflowFailedError
    | WorkflowExecutionNotFoundError
    | RuntimeClientError
  > {
    type Ok = ClientInferOutput<TContract["workflows"][TWorkflowName]>;
    type Err =
      | WorkflowContractErrorsOf<TContract["workflows"][TWorkflowName]>
      | WorkflowNotFoundError
      | WorkflowValidationError
      | WorkflowAlreadyStartedError
      | WorkflowFailedError
      | WorkflowExecutionNotFoundError
      | RuntimeClientError;
    const runPipeline = (currentInput: unknown): AsyncResult<Ok, Err> => {
      const work = async (): Promise<Result<Ok, Err>> => {
        const resolved = await resolveDefinitionAndValidateInput(
          this.contract,
          workflowName,
          currentInput,
          searchAttributes as Record<string, unknown> | undefined,
        );
        // The resolver only ever builds ok/err; assert away the impossible defect.
        assertNoDefect(resolved);
        if (resolved.isErr()) return Err(resolved.error);
        const { definition, validatedInput, typedSearchAttributes } = resolved.value;

        try {
          const result = await this.client.workflow.execute(workflowName, {
            ...temporalOptions,
            taskQueue: this.contract.taskQueue,
            args: [validatedInput],
            ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
          });

          // Output validation runs *after* the Temporal call returns — kept
          // inline because it's specific to executeWorkflow's start-and-wait
          // shape; the helper only handles pre-call concerns.
          const outputResult = await definition.output["~standard"].validate(result);
          if (outputResult.issues) {
            return Err(createWorkflowValidationError(workflowName, "output", outputResult.issues));
          }

          return Ok(outputResult.value as Ok);
        } catch (error) {
          // executeWorkflow combines start + result, so it can surface any of
          // the discriminated kinds. Inline the three checks rather than
          // routing through a dedicated helper — this is the only call site
          // that needs the full union.
          if (error instanceof WorkflowExecutionAlreadyStartedError) {
            return Err(
              new WorkflowAlreadyStartedError(error.workflowType, error.workflowId, error),
            );
          }
          if (error instanceof TemporalWorkflowFailedError) {
            // A failure matching one of the workflow's declared contract
            // errors rehydrates into the typed error (data re-validated
            // against the declared schema) instead of the generic wrapper.
            const rehydrated = await rehydrateWorkflowContractError(definition, error.cause);
            if (rehydrated) {
              return Err(rehydrated as Err);
            }
            // Forward Temporal's nested cause directly — see
            // {@link classifyResultError} for the same rationale: Temporal's
            // `WorkflowFailedError` is a wrapper, and the actionable failure
            // (ApplicationFailure, CancelledFailure, etc.) lives on `.cause`.
            // Temporal types `cause` as `Error | undefined`, but the SDK only
            // ever populates it with a `TemporalFailure` subclass here; narrow
            // with the public union so the typed `cause` lines up with the
            // surfaced `WorkflowFailedError`.
            return Err(
              new WorkflowFailedError(
                temporalOptions.workflowId,
                error.cause as TemporalFailure | undefined,
              ),
            );
          }
          if (error instanceof TemporalWorkflowNotFoundError) {
            return Err(
              new WorkflowExecutionNotFoundError(
                error.workflowId || temporalOptions.workflowId,
                error.runId,
                error,
              ),
            );
          }
          return Err(createRuntimeClientError("executeWorkflow", error));
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
   * Get a handle to an existing workflow with AsyncResult pattern
   *
   * @example
   * ```ts
   * const handleResult = await client.getHandle('processOrder', 'order-123');
   * await handleResult.match({
   *   ok: async (handle) => {
   *     const result = await handle.result();
   *     // ... handle result
   *   },
   *   err: (error) => console.error('Failed to get handle:', error),
   *   defect: (cause) => console.error('Unexpected failure:', cause),
   * });
   * ```
   */
  getHandle<TWorkflowName extends keyof TContract["workflows"] & string>(
    workflowName: TWorkflowName,
    workflowId: string,
  ): AsyncResult<
    TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>,
    WorkflowNotFoundError | RuntimeClientError
  > {
    type Ok = TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>;
    type Err = WorkflowNotFoundError | RuntimeClientError;
    const work = async (): Promise<Result<Ok, Err>> => {
      const definition = this.contract.workflows[workflowName];
      if (!definition) {
        return Err(createWorkflowNotFoundError(workflowName, this.contract));
      }

      try {
        const handle = this.client.workflow.getHandle(workflowId);
        return Ok(this.createTypedHandle(handle, workflowName, definition) as Ok);
      } catch (error) {
        return Err(createRuntimeClientError("getHandle", error));
      }
    };
    return makeAsyncResult(work);
  }

  private createTypedHandle<TWorkflow extends AnyWorkflowDefinition>(
    workflowHandle: WorkflowHandle,
    workflowName: string,
    definition: TWorkflow,
  ): TypedWorkflowHandle<TWorkflow> {
    const queries = buildValidatedProxy({
      defs: definition.queries,
      operation: "query",
      workflowName,
      workflowId: workflowHandle.workflowId,
      interceptors: this.interceptors,
      makeValidationError: (name, direction, issues) =>
        new QueryValidationError(name, direction, issues),
      invoke: (name, validated) => workflowHandle.query(name, validated),
      validateOutput: (def) => def.output,
    }) as TypedWorkflowHandle<TWorkflow>["queries"];

    const signals = buildValidatedProxy({
      defs: definition.signals,
      operation: "signal",
      workflowName,
      workflowId: workflowHandle.workflowId,
      interceptors: this.interceptors,
      makeValidationError: (name, _direction, issues) => new SignalValidationError(name, issues),
      invoke: async (name, validated) => {
        await workflowHandle.signal(name, validated);
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
      invoke: (name, validated) => workflowHandle.executeUpdate(name, { args: [validated] }),
      validateOutput: (def) => def.output,
    }) as TypedWorkflowHandle<TWorkflow>["updates"];

    return {
      workflowId: workflowHandle.workflowId,
      queries,
      signals,
      updates,
      result: (): AsyncResult<
        ClientInferOutput<TWorkflow>,
        | WorkflowContractErrorsOf<TWorkflow>
        | WorkflowValidationError
        | WorkflowFailedError
        | WorkflowExecutionNotFoundError
        | RuntimeClientError
      > => {
        type Ok = ClientInferOutput<TWorkflow>;
        type Err =
          | WorkflowContractErrorsOf<TWorkflow>
          | WorkflowValidationError
          | WorkflowFailedError
          | WorkflowExecutionNotFoundError
          | RuntimeClientError;
        const work = async (): Promise<Result<Ok, Err>> => {
          try {
            const result = await workflowHandle.result();
            const outputResult = await definition.output["~standard"].validate(result);
            if (outputResult.issues) {
              return Err(
                new WorkflowValidationError(
                  workflowHandle.workflowId,
                  "output",
                  outputResult.issues,
                ),
              );
            }
            return Ok(outputResult.value as Ok);
          } catch (error) {
            // A failure matching one of the workflow's declared contract
            // errors rehydrates into the typed error; everything else falls
            // through to the generic classification.
            if (error instanceof TemporalWorkflowFailedError) {
              const rehydrated = await rehydrateWorkflowContractError(definition, error.cause);
              if (rehydrated) {
                return Err(rehydrated as Err);
              }
            }
            return Err(classifyResultError("result", error, workflowHandle.workflowId));
          }
        };
        return makeAsyncResult(work);
      },
      terminate: (
        reason?: string,
      ): AsyncResult<void, WorkflowExecutionNotFoundError | RuntimeClientError> =>
        fromPromise(workflowHandle.terminate(reason), (error) =>
          classifyHandleError("terminate", error, workflowHandle.workflowId),
        ).map(() => undefined),
      cancel: (): AsyncResult<void, WorkflowExecutionNotFoundError | RuntimeClientError> =>
        fromPromise(workflowHandle.cancel(), (error) =>
          classifyHandleError("cancel", error, workflowHandle.workflowId),
        ).map(() => undefined),
      describe: (): AsyncResult<
        Awaited<ReturnType<WorkflowHandle["describe"]>>,
        WorkflowExecutionNotFoundError | RuntimeClientError
      > =>
        fromPromise(workflowHandle.describe(), (error) =>
          classifyHandleError("describe", error, workflowHandle.workflowId),
        ),
      fetchHistory: (): AsyncResult<
        Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>,
        WorkflowExecutionNotFoundError | RuntimeClientError
      > =>
        fromPromise(workflowHandle.fetchHistory(), (error) =>
          classifyHandleError("fetchHistory", error, workflowHandle.workflowId),
        ),
    };
  }
}

function createRuntimeClientError(operation: string, error: unknown): RuntimeClientError {
  return new RuntimeClientError(operation, error);
}

function createWorkflowNotFoundError(
  workflowName: string | number | symbol,
  contract: ContractDefinition,
): WorkflowNotFoundError {
  return new WorkflowNotFoundError(String(workflowName), Object.keys(contract.workflows));
}

function createWorkflowValidationError(
  workflowName: string | number | symbol,
  direction: "input" | "output",
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): WorkflowValidationError {
  return new WorkflowValidationError(String(workflowName), direction, issues);
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
  readonly invoke: (name: string, validatedInput: unknown) => Promise<unknown>;
  /**
   * Returns the schema to validate the invoke result against, or `null` to skip
   * output validation (used by signals, which don't return a value).
   */
  readonly validateOutput: (def: TDef) => StandardSchemaV1 | null;
};

/**
 * Build a `{ name: (args) => AsyncResult<...> }` proxy for a contract's
 * queries/signals/updates. The three call sites differ only in how they
 * invoke Temporal and whether they validate output, so the shared
 * input-validate → invoke → output-validate → wrap-Result pipeline lives
 * here once.
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
  (
    args: unknown,
  ) => AsyncResult<unknown, TValidationError | WorkflowExecutionNotFoundError | RuntimeClientError>
> {
  type ProxyError = TValidationError | WorkflowExecutionNotFoundError | RuntimeClientError;
  const proxy: Record<string, (args: unknown) => AsyncResult<unknown, ProxyError>> = {};
  if (!defs) return proxy;

  for (const [name, def] of Object.entries(defs)) {
    const runPipeline = (currentInput: unknown): AsyncResult<unknown, ProxyError> => {
      const work = async (): Promise<Result<unknown, ProxyError>> => {
        const inputResult = await def.input["~standard"].validate(currentInput);
        if (inputResult.issues) {
          return Err(makeValidationError(name, "input", inputResult.issues));
        }

        try {
          const result = await invoke(name, inputResult.value);
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
          return Err(classifyHandleError(operation, error, workflowId));
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
