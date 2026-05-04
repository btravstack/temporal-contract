import { Client, WorkflowHandle } from "@temporalio/client";
import type { WorkflowSignalWithStartOptions, WorkflowStartOptions } from "@temporalio/client";
import {
  defineSearchAttributeKey,
  type SearchAttributePair,
  TypedSearchAttributes,
} from "@temporalio/common";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  ContractDefinition,
  SearchAttributeDefinition,
  SearchAttributeKindToType,
  SignalDefinition,
  WorkflowDefinition,
} from "@temporal-contract/contract";
import type {
  ClientInferInput,
  ClientInferOutput,
  ClientInferWorkflowQueries,
  ClientInferWorkflowSignals,
  ClientInferWorkflowUpdates,
} from "./types.js";
import { ResultAsync, type Result, ok, err } from "neverthrow";
import {
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
  makeResultAsync,
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
export type TypedSearchAttributeMap<TWorkflow extends WorkflowDefinition> =
  TWorkflow["searchAttributes"] extends Record<string, SearchAttributeDefinition>
    ? {
        [K in keyof TWorkflow["searchAttributes"]]?: SearchAttributeKindToType<
          TWorkflow["searchAttributes"][K]["kind"]
        >;
      }
    : never;

export type TypedWorkflowStartOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"],
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
  TWorkflowName extends keyof TContract["workflows"],
  TSignalName extends keyof TContract["workflows"][TWorkflowName]["signals"] & string,
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
export type TypedWorkflowHandleWithSignaledRunId<TWorkflow extends WorkflowDefinition> =
  TypedWorkflowHandle<TWorkflow> & {
    /**
     * The Run Id of the bound Workflow at the time of `signalWithStart`. Since
     * `signalWithStart` may have signaled an existing Workflow Chain, this is
     * not necessarily the `firstExecutionRunId`.
     */
    readonly signaledRunId: string;
  };

/**
 * Translate the contract's typed `searchAttributes` map (declared
 * name → value) into a Temporal `TypedSearchAttributes` instance, so the
 * Temporal client honours indexing when starting the workflow.
 *
 * Workflows without a `searchAttributes` block (or callers passing no
 * values) skip the conversion entirely and return `undefined`, matching
 * the Temporal SDK's "absent ≠ empty" semantics.
 */
function toTypedSearchAttributes(
  workflowDef: WorkflowDefinition,
  values: Record<string, unknown> | undefined,
): TypedSearchAttributes | undefined {
  if (!values || !workflowDef.searchAttributes) return undefined;
  const pairs: SearchAttributePair[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const def = (workflowDef.searchAttributes as Record<string, SearchAttributeDefinition>)[name];
    if (!def) continue;
    const key = defineSearchAttributeKey(name, def.kind);
    pairs.push({ key, value } as SearchAttributePair);
  }
  return pairs.length > 0 ? new TypedSearchAttributes(pairs) : undefined;
}

/**
 * Typed workflow handle with validated results using neverthrow Result/ResultAsync
 */
export type TypedWorkflowHandle<TWorkflow extends WorkflowDefinition> = {
  workflowId: string;

  /**
   * Type-safe queries based on workflow definition with Result pattern
   * Each query returns ResultAsync<T, Error> instead of Promise<T>
   */
  queries: {
    [K in keyof ClientInferWorkflowQueries<TWorkflow>]: ClientInferWorkflowQueries<TWorkflow>[K] extends (
      ...args: infer Args
    ) => ResultAsync<infer R, Error>
      ? (
          ...args: Args
        ) => ResultAsync<
          R,
          QueryValidationError | WorkflowExecutionNotFoundError | RuntimeClientError
        >
      : never;
  };

  /**
   * Type-safe signals based on workflow definition with Result pattern
   * Each signal returns ResultAsync<void, Error> instead of Promise<void>
   */
  signals: {
    [K in keyof ClientInferWorkflowSignals<TWorkflow>]: ClientInferWorkflowSignals<TWorkflow>[K] extends (
      ...args: infer Args
    ) => ResultAsync<void, Error>
      ? (
          ...args: Args
        ) => ResultAsync<
          void,
          SignalValidationError | WorkflowExecutionNotFoundError | RuntimeClientError
        >
      : never;
  };

  /**
   * Type-safe updates based on workflow definition with Result pattern
   * Each update returns ResultAsync<T, Error> instead of Promise<T>
   */
  updates: {
    [K in keyof ClientInferWorkflowUpdates<TWorkflow>]: ClientInferWorkflowUpdates<TWorkflow>[K] extends (
      ...args: infer Args
    ) => ResultAsync<infer R, Error>
      ? (
          ...args: Args
        ) => ResultAsync<
          R,
          UpdateValidationError | WorkflowExecutionNotFoundError | RuntimeClientError
        >
      : never;
  };

  /**
   * Get workflow result with Result pattern
   */
  result: () => ResultAsync<
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
  ) => ResultAsync<void, WorkflowExecutionNotFoundError | RuntimeClientError>;

  /**
   * Cancel workflow with Result pattern
   */
  cancel: () => ResultAsync<void, WorkflowExecutionNotFoundError | RuntimeClientError>;

  /**
   * Get workflow execution description including status and metadata
   */
  describe: () => ResultAsync<
    Awaited<ReturnType<WorkflowHandle["describe"]>>,
    WorkflowExecutionNotFoundError | RuntimeClientError
  >;

  /**
   * Fetch the workflow execution history
   */
  fetchHistory: () => ResultAsync<
    Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>,
    WorkflowExecutionNotFoundError | RuntimeClientError
  >;
};

/**
 * Typed Temporal client with neverthrow Result/ResultAsync pattern based on a contract
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
   * The package's peer dep is pinned to `^1.16.0` so the standard install
   * paths surface a peer-dependency warning rather than a runtime crash.
   *
   * @example
   * ```ts
   * const result = await client.schedule.create("processOrder", {
   *   scheduleId: "daily-sweep",
   *   spec: { cronExpressions: ["0 2 * * *"] },
   *   args: { orderId: "sweep" },
   * });
   *
   * result.match(
   *   async (handle) => { await handle.pause("maintenance"); },
   *   (error) => console.error("schedule create failed", error),
   * );
   * ```
   */
  readonly schedule: TypedScheduleClient<TContract>;

  private constructor(
    private readonly contract: TContract,
    private readonly client: Client,
  ) {
    // `client.schedule` is the ScheduleClient wired into Temporal's
    // top-level `Client` since 1.16. Fail early with a clear message if a
    // consumer is on an older version (peer dep is pinned to ^1.16, but
    // installs that ignore peer-dep warnings shouldn't crash with a
    // confusing `Cannot read properties of undefined`).
    if (!client.schedule) {
      throw new Error(
        "TypedClient requires @temporalio/client >= 1.16 (the Schedule API was added in 1.16). " +
          "Found a Client instance without a `schedule` property — please upgrade.",
      );
    }
    this.schedule = new TypedScheduleClient(contract, client.schedule);
  }

  /**
   * Create a typed Temporal client with neverthrow pattern from a contract
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
   * result.match(
   *   (output) => console.log('Success:', output),
   *   (error) => console.error('Failed:', error),
   * );
   * ```
   */
  static create<TContract extends ContractDefinition>(
    contract: TContract,
    client: Client,
  ): TypedClient<TContract> {
    return new TypedClient(contract, client);
  }

  /**
   * Start a workflow and return a typed handle with ResultAsync pattern
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
   * handleResult.match(
   *   async (handle) => {
   *     const result = await handle.result();
   *     // ... handle result
   *   },
   *   (error) => console.error('Failed to start:', error),
   * );
   * ```
   */
  startWorkflow<TWorkflowName extends keyof TContract["workflows"]>(
    workflowName: TWorkflowName,
    {
      args,
      searchAttributes,
      ...temporalOptions
    }: TypedWorkflowStartOptions<TContract, TWorkflowName>,
  ): ResultAsync<
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
      const definition = this.contract.workflows[workflowName as string];
      if (!definition) {
        return err(createWorkflowNotFoundError(workflowName, this.contract));
      }

      const inputResult = await definition.input["~standard"].validate(args);
      if (inputResult.issues) {
        return err(createWorkflowValidationError(workflowName, "input", inputResult.issues));
      }

      const typedSearchAttributes = toTypedSearchAttributes(
        definition,
        searchAttributes as Record<string, unknown> | undefined,
      );

      try {
        const handle = await this.client.workflow.start(workflowName as string, {
          ...temporalOptions,
          taskQueue: this.contract.taskQueue,
          args: [inputResult.value],
          ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
        });
        return ok(this.createTypedHandle(handle, definition) as Ok);
      } catch (error) {
        return err(classifyStartError("startWorkflow", error));
      }
    };
    return makeResultAsync(work);
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
   * result.match(
   *   (handle) => console.log('signaled run', handle.signaledRunId),
   *   (error) => console.error('signalWithStart failed', error),
   * );
   * ```
   */
  signalWithStart<
    TWorkflowName extends keyof TContract["workflows"],
    TSignalName extends keyof TContract["workflows"][TWorkflowName]["signals"] & string,
  >(
    workflowName: TWorkflowName,
    {
      args,
      signalName,
      signalArgs,
      searchAttributes,
      ...temporalOptions
    }: TypedSignalWithStartOptions<TContract, TWorkflowName, TSignalName>,
  ): ResultAsync<
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
      const definition = this.contract.workflows[workflowName as string];
      if (!definition) {
        return err(createWorkflowNotFoundError(workflowName, this.contract));
      }

      // Validate workflow input
      const inputResult = await definition.input["~standard"].validate(args);
      if (inputResult.issues) {
        return err(createWorkflowValidationError(workflowName, "input", inputResult.issues));
      }

      // Validate signal input
      const signalDef = (definition.signals as Record<string, SignalDefinition> | undefined)?.[
        signalName
      ];
      if (!signalDef) {
        // Type-level constraint should already prevent this; defensive for
        // raw-call / union-typed-name corner cases.
        return err(
          new SignalValidationError(signalName, [
            {
              message: `Signal "${signalName}" is not declared on workflow "${String(workflowName)}".`,
            },
          ]),
        );
      }
      const signalInputResult = await signalDef.input["~standard"].validate(signalArgs);
      if (signalInputResult.issues) {
        return err(new SignalValidationError(signalName, signalInputResult.issues));
      }

      const typedSearchAttributes = toTypedSearchAttributes(
        definition,
        searchAttributes as Record<string, unknown> | undefined,
      );

      try {
        const handle = await this.client.workflow.signalWithStart(workflowName as string, {
          ...temporalOptions,
          taskQueue: this.contract.taskQueue,
          args: [inputResult.value],
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
    return makeResultAsync(work);
  }

  /**
   * Execute a workflow (start and wait for result) with ResultAsync pattern
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
   * result.match(
   *   (output) => console.log('Order processed:', output.status),
   *   (error) => console.error('Processing failed:', error),
   * );
   * ```
   */
  executeWorkflow<TWorkflowName extends keyof TContract["workflows"]>(
    workflowName: TWorkflowName,
    {
      args,
      searchAttributes,
      ...temporalOptions
    }: TypedWorkflowStartOptions<TContract, TWorkflowName>,
  ): ResultAsync<
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
      const definition = this.contract.workflows[workflowName as string];
      if (!definition) {
        return err(createWorkflowNotFoundError(workflowName, this.contract));
      }

      const inputResult = await definition.input["~standard"].validate(args);
      if (inputResult.issues) {
        return err(createWorkflowValidationError(workflowName, "input", inputResult.issues));
      }

      const typedSearchAttributes = toTypedSearchAttributes(
        definition,
        searchAttributes as Record<string, unknown> | undefined,
      );

      try {
        const result = await this.client.workflow.execute(workflowName as string, {
          ...temporalOptions,
          taskQueue: this.contract.taskQueue,
          args: [inputResult.value],
          ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
        });

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
          return err(new WorkflowFailedError(temporalOptions.workflowId, error.cause));
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
    return makeResultAsync(work);
  }

  /**
   * Get a handle to an existing workflow with ResultAsync pattern
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
  getHandle<TWorkflowName extends keyof TContract["workflows"]>(
    workflowName: TWorkflowName,
    workflowId: string,
  ): ResultAsync<
    TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>,
    WorkflowNotFoundError | RuntimeClientError
  > {
    type Ok = TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>;
    type Err = WorkflowNotFoundError | RuntimeClientError;
    const work = async (): Promise<Result<Ok, Err>> => {
      const definition = this.contract.workflows[workflowName as string];
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
    return makeResultAsync(work);
  }

  private createTypedHandle<TWorkflow extends WorkflowDefinition>(
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
      result: (): ResultAsync<
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
        return makeResultAsync(work);
      },
      terminate: (
        reason?: string,
      ): ResultAsync<void, WorkflowExecutionNotFoundError | RuntimeClientError> =>
        ResultAsync.fromPromise(workflowHandle.terminate(reason), (error) =>
          classifyHandleError("terminate", error, workflowHandle.workflowId),
        ).map(() => undefined),
      cancel: (): ResultAsync<void, WorkflowExecutionNotFoundError | RuntimeClientError> =>
        ResultAsync.fromPromise(workflowHandle.cancel(), (error) =>
          classifyHandleError("cancel", error, workflowHandle.workflowId),
        ).map(() => undefined),
      describe: (): ResultAsync<
        Awaited<ReturnType<WorkflowHandle["describe"]>>,
        WorkflowExecutionNotFoundError | RuntimeClientError
      > =>
        ResultAsync.fromPromise(workflowHandle.describe(), (error) =>
          classifyHandleError("describe", error, workflowHandle.workflowId),
        ),
      fetchHistory: (): ResultAsync<
        Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>,
        WorkflowExecutionNotFoundError | RuntimeClientError
      > =>
        ResultAsync.fromPromise(workflowHandle.fetchHistory(), (error) =>
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
 * Build a `{ name: (args) => ResultAsync<...> }` proxy for a contract's
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
  ) => ResultAsync<unknown, TValidationError | WorkflowExecutionNotFoundError | RuntimeClientError>
> {
  const proxy: Record<
    string,
    (
      args: unknown,
    ) => ResultAsync<
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
      return makeResultAsync(work);
    };
  }

  return proxy;
}
