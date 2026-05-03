import { Client, WorkflowHandle } from "@temporalio/client";
import type { WorkflowStartOptions } from "@temporalio/client";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ContractDefinition, WorkflowDefinition } from "@temporal-contract/contract";
import type {
  ClientInferInput,
  ClientInferOutput,
  ClientInferWorkflowQueries,
  ClientInferWorkflowSignals,
  ClientInferWorkflowUpdates,
} from "./types.js";
import { Future, Result } from "@swan-io/boxed";
import {
  WorkflowNotFoundError,
  WorkflowValidationError,
  QueryValidationError,
  SignalValidationError,
  UpdateValidationError,
  RuntimeClientError,
} from "./errors.js";

export type TypedWorkflowStartOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"],
> = Omit<WorkflowStartOptions, "taskQueue" | "args"> & {
  args: ClientInferInput<TContract["workflows"][TWorkflowName]>;
};

/**
 * Typed workflow handle with validated results using Result/Future pattern
 */
export type TypedWorkflowHandle<TWorkflow extends WorkflowDefinition> = {
  workflowId: string;

  /**
   * Type-safe queries based on workflow definition with Result pattern
   * Each query returns Future<Result<T, Error>> instead of Promise<T>
   */
  queries: {
    [K in keyof ClientInferWorkflowQueries<TWorkflow>]: ClientInferWorkflowQueries<TWorkflow>[K] extends (
      ...args: infer Args
    ) => Future<Result<infer R, Error>>
      ? (...args: Args) => Future<Result<R, QueryValidationError | RuntimeClientError>>
      : never;
  };

  /**
   * Type-safe signals based on workflow definition with Result pattern
   * Each signal returns Future<Result<void, Error>> instead of Promise<void>
   */
  signals: {
    [K in keyof ClientInferWorkflowSignals<TWorkflow>]: ClientInferWorkflowSignals<TWorkflow>[K] extends (
      ...args: infer Args
    ) => Future<Result<void, Error>>
      ? (...args: Args) => Future<Result<void, SignalValidationError | RuntimeClientError>>
      : never;
  };

  /**
   * Type-safe updates based on workflow definition with Result pattern
   * Each update returns Future<Result<T, Error>> instead of Promise<T>
   */
  updates: {
    [K in keyof ClientInferWorkflowUpdates<TWorkflow>]: ClientInferWorkflowUpdates<TWorkflow>[K] extends (
      ...args: infer Args
    ) => Future<Result<infer R, Error>>
      ? (...args: Args) => Future<Result<R, UpdateValidationError | RuntimeClientError>>
      : never;
  };

  /**
   * Get workflow result with Result pattern
   */
  result: () => Future<
    Result<ClientInferOutput<TWorkflow>, WorkflowValidationError | RuntimeClientError>
  >;

  /**
   * Terminate workflow with Result pattern
   */
  terminate: (reason?: string) => Future<Result<void, RuntimeClientError>>;

  /**
   * Cancel workflow with Result pattern
   */
  cancel: () => Future<Result<void, RuntimeClientError>>;

  /**
   * Get workflow execution description including status and metadata
   */
  describe: () => Future<
    Result<Awaited<ReturnType<WorkflowHandle["describe"]>>, RuntimeClientError>
  >;

  /**
   * Fetch the workflow execution history
   */
  fetchHistory: () => Future<
    Result<Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>, RuntimeClientError>
  >;
};

/**
 * Typed Temporal client with Result/Future pattern based on a contract
 *
 * Provides type-safe methods to start and execute workflows
 * defined in the contract, with explicit error handling using Result pattern.
 */
export class TypedClient<TContract extends ContractDefinition> {
  private constructor(
    private readonly contract: TContract,
    private readonly client: Client,
  ) {}

  /**
   * Create a typed Temporal client with boxed pattern from a contract
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
   * result.match({
   *   Ok: (output) => console.log('Success:', output),
   *   Error: (error) => console.error('Failed:', error),
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
   * Start a workflow and return a typed handle with Future pattern
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
   * handleResult.match({
   *   Ok: async (handle) => {
   *     const result = await handle.result();
   *     // ... handle result
   *   },
   *   Error: (error) => console.error('Failed to start:', error),
   * });
   * ```
   */
  startWorkflow<TWorkflowName extends keyof TContract["workflows"]>(
    workflowName: TWorkflowName,
    { args, ...temporalOptions }: TypedWorkflowStartOptions<TContract, TWorkflowName>,
  ): Future<
    Result<
      TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>,
      WorkflowNotFoundError | WorkflowValidationError | RuntimeClientError
    >
  > {
    type Ok = TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>;
    type Err = WorkflowNotFoundError | WorkflowValidationError | RuntimeClientError;
    const work = async (): Promise<Result<Ok, Err>> => {
      const definition = this.contract.workflows[workflowName as string];
      if (!definition) {
        return Result.Error(createWorkflowNotFoundError(workflowName, this.contract));
      }

      const inputResult = await definition.input["~standard"].validate(args);
      if (inputResult.issues) {
        return Result.Error(
          createWorkflowValidationError(workflowName, "input", inputResult.issues),
        );
      }

      try {
        const handle = await this.client.workflow.start(workflowName as string, {
          ...temporalOptions,
          taskQueue: this.contract.taskQueue,
          args: [inputResult.value],
        });
        return Result.Ok(this.createTypedHandle(handle, definition) as Ok);
      } catch (error) {
        return Result.Error(createRuntimeClientError("startWorkflow", error));
      }
    };
    return makeFuture(work);
  }

  /**
   * Execute a workflow (start and wait for result) with Future/Result pattern
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
   * result.match({
   *   Ok: (output) => console.log('Order processed:', output.status),
   *   Error: (error) => console.error('Processing failed:', error),
   * });
   * ```
   */
  executeWorkflow<TWorkflowName extends keyof TContract["workflows"]>(
    workflowName: TWorkflowName,
    { args, ...temporalOptions }: TypedWorkflowStartOptions<TContract, TWorkflowName>,
  ): Future<
    Result<
      ClientInferOutput<TContract["workflows"][TWorkflowName]>,
      WorkflowNotFoundError | WorkflowValidationError | RuntimeClientError
    >
  > {
    type Ok = ClientInferOutput<TContract["workflows"][TWorkflowName]>;
    type Err = WorkflowNotFoundError | WorkflowValidationError | RuntimeClientError;
    const work = async (): Promise<Result<Ok, Err>> => {
      const definition = this.contract.workflows[workflowName as string];
      if (!definition) {
        return Result.Error(createWorkflowNotFoundError(workflowName, this.contract));
      }

      const inputResult = await definition.input["~standard"].validate(args);
      if (inputResult.issues) {
        return Result.Error(
          createWorkflowValidationError(workflowName, "input", inputResult.issues),
        );
      }

      try {
        const result = await this.client.workflow.execute(workflowName as string, {
          ...temporalOptions,
          taskQueue: this.contract.taskQueue,
          args: [inputResult.value],
        });

        const outputResult = await definition.output["~standard"].validate(result);
        if (outputResult.issues) {
          return Result.Error(
            createWorkflowValidationError(workflowName, "output", outputResult.issues),
          );
        }

        return Result.Ok(outputResult.value as Ok);
      } catch (error) {
        return Result.Error(createRuntimeClientError("executeWorkflow", error));
      }
    };
    return makeFuture(work);
  }

  /**
   * Get a handle to an existing workflow with Future/Result pattern
   *
   * @example
   * ```ts
   * const handleResult = await client.getHandle('processOrder', 'order-123');
   * handleResult.match({
   *   Ok: async (handle) => {
   *     const result = await handle.result();
   *     // ... handle result
   *   },
   *   Error: (error) => console.error('Failed to get handle:', error),
   * });
   * ```
   */
  getHandle<TWorkflowName extends keyof TContract["workflows"]>(
    workflowName: TWorkflowName,
    workflowId: string,
  ): Future<
    Result<
      TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>,
      WorkflowNotFoundError | RuntimeClientError
    >
  > {
    type Ok = TypedWorkflowHandle<TContract["workflows"][TWorkflowName]>;
    type Err = WorkflowNotFoundError | RuntimeClientError;
    const work = async (): Promise<Result<Ok, Err>> => {
      const definition = this.contract.workflows[workflowName as string];
      if (!definition) {
        return Result.Error(createWorkflowNotFoundError(workflowName, this.contract));
      }

      try {
        const handle = this.client.workflow.getHandle(workflowId);
        return Result.Ok(this.createTypedHandle(handle, definition) as Ok);
      } catch (error) {
        return Result.Error(createRuntimeClientError("getHandle", error));
      }
    };
    return makeFuture(work);
  }

  private createTypedHandle<TWorkflow extends WorkflowDefinition>(
    workflowHandle: WorkflowHandle,
    definition: TWorkflow,
  ): TypedWorkflowHandle<TWorkflow> {
    const queries = buildValidatedProxy({
      defs: definition.queries,
      operation: "query",
      makeValidationError: (name, direction, issues) =>
        new QueryValidationError(name, direction, issues),
      invoke: (name, validated) => workflowHandle.query(name, validated),
      validateOutput: (def) => def.output,
    }) as TypedWorkflowHandle<TWorkflow>["queries"];

    const signals = buildValidatedProxy({
      defs: definition.signals,
      operation: "signal",
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
      result: (): Future<
        Result<ClientInferOutput<TWorkflow>, WorkflowValidationError | RuntimeClientError>
      > => {
        type Ok = ClientInferOutput<TWorkflow>;
        type Err = WorkflowValidationError | RuntimeClientError;
        const work = async (): Promise<Result<Ok, Err>> => {
          try {
            const result = await workflowHandle.result();
            const outputResult = await definition.output["~standard"].validate(result);
            if (outputResult.issues) {
              return Result.Error(
                new WorkflowValidationError(
                  workflowHandle.workflowId,
                  "output",
                  outputResult.issues,
                ),
              );
            }
            return Result.Ok(outputResult.value as Ok);
          } catch (error) {
            return Result.Error(createRuntimeClientError("result", error));
          }
        };
        return makeFuture(work);
      },
      terminate: (reason?: string): Future<Result<void, RuntimeClientError>> =>
        Future.fromPromise(workflowHandle.terminate(reason))
          .mapError((error) => createRuntimeClientError("terminate", error))
          .mapOk(() => undefined),
      cancel: (): Future<Result<void, RuntimeClientError>> =>
        Future.fromPromise(workflowHandle.cancel())
          .mapError((error) => createRuntimeClientError("cancel", error))
          .mapOk(() => undefined),
      describe: (): Future<
        Result<Awaited<ReturnType<WorkflowHandle["describe"]>>, RuntimeClientError>
      > =>
        Future.fromPromise(workflowHandle.describe()).mapError((error) =>
          createRuntimeClientError("describe", error),
        ),
      fetchHistory: (): Future<
        Result<Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>, RuntimeClientError>
      > =>
        Future.fromPromise(workflowHandle.fetchHistory()).mapError((error) =>
          createRuntimeClientError("fetchHistory", error),
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

/**
 * Wrap an async result-producing function in a Future, catching any unexpected
 * rejection as a `RuntimeClientError`. The work function is expected to handle
 * its own domain errors and return a `Result.Error(...)` for them; the catch
 * here is a safety net for thrown exceptions the work didn't anticipate.
 */
function makeFuture<T, E>(
  work: () => Promise<Result<T, E>>,
): Future<Result<T, E | RuntimeClientError>> {
  return Future.make((resolve) => {
    work()
      .then(resolve)
      .catch((e: unknown) =>
        resolve(Result.Error<T, E | RuntimeClientError>(createRuntimeClientError("unexpected", e))),
      );
  });
}

type DefWithInput = { readonly input: StandardSchemaV1 };

type ProxyOptions<TDef extends DefWithInput, TValidationError extends Error> = {
  readonly defs: Record<string, TDef> | undefined;
  readonly operation: string;
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
 * Build a `{ name: (args) => Future<Result<...>> }` proxy for a contract's
 * queries/signals/updates. The three call sites differ only in how they
 * invoke Temporal and whether they validate output, so the shared
 * input-validate → invoke → output-validate → wrap-Result pipeline lives
 * here once.
 */
function buildValidatedProxy<TDef extends DefWithInput, TValidationError extends Error>({
  defs,
  operation,
  makeValidationError,
  invoke,
  validateOutput,
}: ProxyOptions<TDef, TValidationError>): Record<
  string,
  (args: unknown) => Future<Result<unknown, TValidationError | RuntimeClientError>>
> {
  const proxy: Record<
    string,
    (args: unknown) => Future<Result<unknown, TValidationError | RuntimeClientError>>
  > = {};
  if (!defs) return proxy;

  for (const [name, def] of Object.entries(defs)) {
    proxy[name] = (args) => {
      const work = async (): Promise<Result<unknown, TValidationError | RuntimeClientError>> => {
        const inputResult = await def.input["~standard"].validate(args);
        if (inputResult.issues) {
          return Result.Error(makeValidationError(name, "input", inputResult.issues));
        }

        try {
          const result = await invoke(name, inputResult.value);
          const outputSchema = validateOutput(def);
          if (!outputSchema) {
            return Result.Ok(result);
          }
          const outputResult = await outputSchema["~standard"].validate(result);
          if (outputResult.issues) {
            return Result.Error(makeValidationError(name, "output", outputResult.issues));
          }
          return Result.Ok(outputResult.value);
        } catch (error) {
          return Result.Error(createRuntimeClientError(operation, error));
        }
      };
      return makeFuture(work);
    };
  }

  return proxy;
}
