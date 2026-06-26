import { Client, WorkflowHandle } from "@temporalio/client";
import type { WorkflowSignalWithStartOptions, WorkflowStartOptions } from "@temporalio/client";
import { defineSearchAttributeKey, TypedSearchAttributes } from "@temporalio/common";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  AnyWorkflowDefinition,
  ContractDefinition,
  SearchAttributeDefinition,
  SearchAttributeKindToType,
  SignalDefinition,
  SignalNamesOf,
} from "@temporal-contract/contract";
import type {
  ClientInferInput,
  ClientInferOutput,
  ClientInferWorkflowQueries,
  ClientInferWorkflowSignals,
  ClientInferWorkflowUpdates,
} from "./types.js";
import { type AsyncResult, type Result, ok, err, isOk, isErr, fromPromise } from "unthrown";
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
import { TypedScheduleClient } from "./schedule.js";
import {
  classifyHandleError,
  classifyResultError,
  classifyStartError,
  makeAsyncResult,
  toTypedSearchAttributes,
} from "./internal.js";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { WorkflowFailedError as TemporalWorkflowFailedError } from "@temporalio/client";
import { WorkflowNotFoundError as TemporalWorkflowNotFoundError } from "@temporalio/common";

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
 * if (isOk(description)) {
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
   * Get workflow result with Result pattern
   */
  result: () => AsyncResult<
    ClientInferOutput<TWorkflow>,
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
    return err(createWorkflowNotFoundError(workflowName, contract));
  }

  const inputResult = await definition.input["~standard"].validate(args);
  if (inputResult.issues) {
    return err(createWorkflowValidationError(workflowName, "input", inputResult.issues));
  }

  const searchAttributesResult = toTypedSearchAttributes(
    definition,
    workflowName,
    searchAttributes,
  );
  if (isErr(searchAttributesResult)) return err(searchAttributesResult.error);
  // `toTypedSearchAttributes` only ever builds ok/err; a defect would be a bug.
  if (!isOk(searchAttributesResult)) throw searchAttributesResult.cause;
  const typedSearchAttributes = searchAttributesResult.value;

  return ok({
    definition: definition as TContract["workflows"][TWorkflowName],
    validatedInput: inputResult.value,
    typedSearchAttributes,
  });
}

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
   * Create a typed Temporal client with unthrown pattern from a contract
   *
   * @example
   * ```ts
   * const connection = await Connection.connect();
   * const temporalClient = new Client({ connection });
   * const client = TypedClient.create(myContract, temporalClient);
   *
   * const result = await client.executeWorkflow('processOrder', {
   *   workflowId: 'order-123',
   *   args: { ... },
   * });
   *
   * await result.match({
   *   ok: (output) => console.log('Success:', output),
   *   err: (error) => console.error('Failed:', error),
   *   defect: (cause) => console.error('Unexpected failure:', cause),
   * });
   * ```
   */
  static create<TContract extends ContractDefinition>(
    contract: TContract,
    client: Client,
  ): TypedClient<TContract> {
    return new TypedClient(contract, client);
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
    const work = async (): Promise<Result<Ok, Err>> => {
      const resolved = await resolveDefinitionAndValidateInput(
        this.contract,
        workflowName,
        args,
        searchAttributes as Record<string, unknown> | undefined,
      );
      if (isErr(resolved)) return err(resolved.error);
      // The resolver only ever builds ok/err; a defect would be a genuine bug.
      if (!isOk(resolved)) throw resolved.cause;
      const { definition, validatedInput, typedSearchAttributes } = resolved.value;

      try {
        const handle = await this.client.workflow.start(workflowName, {
          ...temporalOptions,
          taskQueue: this.contract.taskQueue,
          args: [validatedInput],
          ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
        });
        return ok(this.createTypedHandle(handle, definition) as Ok);
      } catch (error) {
        return err(classifyStartError("startWorkflow", error));
      }
    };
    return makeAsyncResult(work);
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

    const work = async (): Promise<Result<Ok, Err>> => {
      const resolved = await resolveDefinitionAndValidateInput(
        this.contract,
        workflowName,
        args,
        searchAttributes as Record<string, unknown> | undefined,
      );
      if (isErr(resolved)) return err(resolved.error);
      // The resolver only ever builds ok/err; a defect would be a genuine bug.
      if (!isOk(resolved)) throw resolved.cause;
      const { definition, validatedInput, typedSearchAttributes } = resolved.value;

      // Validate signal input — call-site-specific, kept inline.
      const signalDef = (definition.signals as Record<string, SignalDefinition> | undefined)?.[
        signalName
      ];
      if (!signalDef) {
        // Type-level constraint should already prevent this; defensive for
        // raw-call / union-typed-name corner cases.
        return err(
          new SignalValidationError(signalName, [
            {
              message: `Signal "${signalName}" is not declared on workflow "${workflowName}".`,
            },
          ]),
        );
      }
      const signalInputResult = await signalDef.input["~standard"].validate(signalArgs);
      if (signalInputResult.issues) {
        return err(new SignalValidationError(signalName, signalInputResult.issues));
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
        const typed = this.createTypedHandle(handle, definition) as TypedWorkflowHandle<
          TContract["workflows"][TWorkflowName]
        >;
        return ok({ ...typed, signaledRunId: handle.signaledRunId } as Ok);
      } catch (error) {
        return err(classifyStartError("signalWithStart", error));
      }
    };
    return makeAsyncResult(work);
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
    | WorkflowNotFoundError
    | WorkflowValidationError
    | WorkflowAlreadyStartedError
    | WorkflowFailedError
    | WorkflowExecutionNotFoundError
    | RuntimeClientError
  > {
    type Ok = ClientInferOutput<TContract["workflows"][TWorkflowName]>;
    type Err =
      | WorkflowNotFoundError
      | WorkflowValidationError
      | WorkflowAlreadyStartedError
      | WorkflowFailedError
      | WorkflowExecutionNotFoundError
      | RuntimeClientError;
    const work = async (): Promise<Result<Ok, Err>> => {
      const resolved = await resolveDefinitionAndValidateInput(
        this.contract,
        workflowName,
        args,
        searchAttributes as Record<string, unknown> | undefined,
      );
      if (isErr(resolved)) return err(resolved.error);
      // The resolver only ever builds ok/err; a defect would be a genuine bug.
      if (!isOk(resolved)) throw resolved.cause;
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
          return err(createWorkflowValidationError(workflowName, "output", outputResult.issues));
        }

        return ok(outputResult.value as Ok);
      } catch (error) {
        // executeWorkflow combines start + result, so it can surface any of
        // the discriminated kinds. Inline the three checks rather than
        // routing through a dedicated helper — this is the only call site
        // that needs the full union.
        if (error instanceof WorkflowExecutionAlreadyStartedError) {
          return err(new WorkflowAlreadyStartedError(error.workflowType, error.workflowId, error));
        }
        if (error instanceof TemporalWorkflowFailedError) {
          // Forward Temporal's nested cause directly — see
          // {@link classifyResultError} for the same rationale: Temporal's
          // `WorkflowFailedError` is a wrapper, and the actionable failure
          // (ApplicationFailure, CancelledFailure, etc.) lives on `.cause`.
          // Temporal types `cause` as `Error | undefined`, but the SDK only
          // ever populates it with a `TemporalFailure` subclass here; narrow
          // with the public union so the typed `cause` lines up with the
          // surfaced `WorkflowFailedError`.
          return err(
            new WorkflowFailedError(
              temporalOptions.workflowId,
              error.cause as TemporalFailure | undefined,
            ),
          );
        }
        if (error instanceof TemporalWorkflowNotFoundError) {
          return err(
            new WorkflowExecutionNotFoundError(
              error.workflowId || temporalOptions.workflowId,
              error.runId,
              error,
            ),
          );
        }
        return err(createRuntimeClientError("executeWorkflow", error));
      }
    };
    return makeAsyncResult(work);
  }

  /**
   * Get a handle to an existing workflow with AsyncResult pattern
   *
   * @example
   * ```ts
   * const handleResult = await client.getHandle('processOrder', 'order-123');
   * handleResult.match(
   *   async (handle) => {
   *     const result = await handle.result();
   *     // ... handle result
   *   },
   *   (error) => console.error('Failed to get handle:', error),
   * );
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
        return err(createWorkflowNotFoundError(workflowName, this.contract));
      }

      try {
        const handle = this.client.workflow.getHandle(workflowId);
        return ok(this.createTypedHandle(handle, definition) as Ok);
      } catch (error) {
        return err(createRuntimeClientError("getHandle", error));
      }
    };
    return makeAsyncResult(work);
  }

  private createTypedHandle<TWorkflow extends AnyWorkflowDefinition>(
    workflowHandle: WorkflowHandle,
    definition: TWorkflow,
  ): TypedWorkflowHandle<TWorkflow> {
    const queries = buildValidatedProxy({
      defs: definition.queries,
      operation: "query",
      workflowId: workflowHandle.workflowId,
      makeValidationError: (name, direction, issues) =>
        new QueryValidationError(name, direction, issues),
      invoke: (name, validated) => workflowHandle.query(name, validated),
      validateOutput: (def) => def.output,
    }) as TypedWorkflowHandle<TWorkflow>["queries"];

    const signals = buildValidatedProxy({
      defs: definition.signals,
      operation: "signal",
      workflowId: workflowHandle.workflowId,
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
      workflowId: workflowHandle.workflowId,
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
        | WorkflowValidationError
        | WorkflowFailedError
        | WorkflowExecutionNotFoundError
        | RuntimeClientError
      > => {
        type Ok = ClientInferOutput<TWorkflow>;
        type Err =
          | WorkflowValidationError
          | WorkflowFailedError
          | WorkflowExecutionNotFoundError
          | RuntimeClientError;
        const work = async (): Promise<Result<Ok, Err>> => {
          try {
            const result = await workflowHandle.result();
            const outputResult = await definition.output["~standard"].validate(result);
            if (outputResult.issues) {
              return err(
                new WorkflowValidationError(
                  workflowHandle.workflowId,
                  "output",
                  outputResult.issues,
                ),
              );
            }
            return ok(outputResult.value as Ok);
          } catch (error) {
            return err(classifyResultError("result", error, workflowHandle.workflowId));
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
  readonly operation: string;
  /**
   * Workflow ID of the handle these proxies bind to. Used by
   * {@link classifyHandleError} to surface
   * {@link WorkflowExecutionNotFoundError} with the targeted ID even when
   * Temporal's error doesn't carry it.
   */
  readonly workflowId: string;
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
  workflowId,
  makeValidationError,
  invoke,
  validateOutput,
}: ProxyOptions<TDef, TValidationError>): Record<
  string,
  (
    args: unknown,
  ) => AsyncResult<unknown, TValidationError | WorkflowExecutionNotFoundError | RuntimeClientError>
> {
  const proxy: Record<
    string,
    (
      args: unknown,
    ) => AsyncResult<
      unknown,
      TValidationError | WorkflowExecutionNotFoundError | RuntimeClientError
    >
  > = {};
  if (!defs) return proxy;

  for (const [name, def] of Object.entries(defs)) {
    proxy[name] = (args) => {
      const work = async (): Promise<
        Result<unknown, TValidationError | WorkflowExecutionNotFoundError | RuntimeClientError>
      > => {
        const inputResult = await def.input["~standard"].validate(args);
        if (inputResult.issues) {
          return err(makeValidationError(name, "input", inputResult.issues));
        }

        try {
          const result = await invoke(name, inputResult.value);
          const outputSchema = validateOutput(def);
          if (!outputSchema) {
            return ok(result);
          }
          const outputResult = await outputSchema["~standard"].validate(result);
          if (outputResult.issues) {
            return err(makeValidationError(name, "output", outputResult.issues));
          }
          return ok(outputResult.value);
        } catch (error) {
          return err(classifyHandleError(operation, error, workflowId));
        }
      };
      return makeAsyncResult(work);
    };
  }

  return proxy;
}
