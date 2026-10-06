import type {
  AnyWorkflowDefinition,
  ContractDefinition,
  InferSignalNames,
  InferUpdateNames,
  SearchAttributeDefinition,
  SignalDefinition,
  UpdateDefinition,
} from "@temporal-contract/contract";
import { TechnicalError } from "@temporal-contract/contract/errors";
import { _internal_reusePolicyFor } from "@temporal-contract/contract/internal";
import { type Client, WithStartWorkflowOperation } from "@temporalio/client";
import type { WorkflowIdConflictPolicy, WorkflowStartOptions } from "@temporalio/client";
import { defineSearchAttributeKey, type TypedSearchAttributes } from "@temporalio/common";
import { type AsyncResult, Ok } from "unthrown";

import {
  type UpdateFailedError,
  type UpdateRejectedError,
  type UpdateRpcTimeoutOrCancelledError,
  type UpdateValidationError,
  type WorkflowAlreadyStartedError,
  type WorkflowValidationError,
  SignalValidationError,
} from "./errors.js";
import {
  createTypedHandle,
  type TypedWorkflowHandle,
  type TypedWorkflowHandleWithSignaledRunId,
  type UpdateOf,
  updateArgs,
  updateOutcome,
  validateUpdateInput,
} from "./handle.js";
import {
  call,
  classifyStartError,
  classifyUpdateError,
  deriveWorkflowId,
  lookupDeclared,
  lookupWorkflow,
  makeAsyncResult,
  type OnRehydrationMiss,
  parseWithSchema,
  validateWorkflowInput,
} from "./internal.js";
import type {
  CreateClientOptions,
  DerivedIdWorkflowName,
  TypedGetHandleOptions,
  TypedSignalWithStartOptions,
  TypedUpdateWithStartOptions,
  TypedWorkflowStartOptions,
} from "./options.js";
import { TypedScheduleClient } from "./schedule.js";
import type {
  ClientInferInput,
  ClientInferOutput,
  TypedSearchAttributeMap,
  WorkflowResultErrorsOf,
} from "./types.js";

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
 * The start options as the implementation sees them: the typed bag with its
 * conditional fields (`args`, `workflowId`, `searchAttributes`) widened, so
 * the rest-spread can decompose it.
 */
type WidenedStartOptions = Omit<
  WorkflowStartOptions,
  "taskQueue" | "args" | "searchAttributes" | "typedSearchAttributes" | "workflowId"
> & { args?: unknown; workflowId?: string; searchAttributes?: Record<string, unknown> };

/**
 * The single start-options builder behind `startWorkflow`, `signalWithStart`
 * and `executeUpdateWithStart`: validate the input, derive the workflow ID,
 * and assemble Temporal's start options from the caller's passthrough
 * fields plus the contract-owned ones.
 */
function prepareStart(
  contract: ContractDefinition,
  workflowName: string,
  options: WidenedStartOptions,
): AsyncResult<
  { definition: AnyWorkflowDefinition; startOptions: WorkflowStartOptions },
  WorkflowValidationError
> {
  const { args, searchAttributes, workflowId, ...temporalOptions } = options;
  return validateWorkflowInput(contract, workflowName, args, searchAttributes, workflowId).map(
    ({ definition, validatedInput, typedSearchAttributes }) => ({
      definition,
      startOptions: {
        ...temporalOptions,
        // Contract-owned fields come last, so nothing in the caller's bag —
        // not even an explicit `undefined` smuggled past the types — can
        // override them. A workflow that derives its ID forbids `workflowId`
        // at the type level; one that doesn't requires it.
        workflowId: deriveWorkflowId(definition, validatedInput) ?? (workflowId as string),
        workflowIdReusePolicy: _internal_reusePolicyFor(definition.startPolicy),
        taskQueue: contract.taskQueue,
        // The caller's ORIGINAL args cross the wire — the worker parses on
        // receive. An omitted payload travels as empty args.
        args: args === undefined ? [] : [args],
        ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
      },
    }),
  );
}

/**
 * Connection-scoped root of the typed client surface.
 *
 * A client is a *connection*; a contract is a *schema*. `TypedClient` owns
 * the connection-lifetime concerns — the eager `ensureConnected()` and the
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

  private readonly onRehydrationMiss: OnRehydrationMiss | undefined;

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

  private constructor(client: Client, onRehydrationMiss: OnRehydrationMiss | undefined) {
    this.raw = client;
    this.onRehydrationMiss = onRehydrationMiss;
  }

  /**
   * Create the connection-scoped typed client.
   *
   * Returns `AsyncResult<TypedClient, never>` — a setup fault is a
   * *technical* infrastructure failure, not an anticipated domain error, so
   * it surfaces on the `Defect` channel (a {@link TechnicalError} instance as
   * the defect's cause), never the modeled `Err` channel: when the client's
   * connection exposes `ensureConnected`, it is awaited eagerly so a bad
   * address/namespace surfaces here instead of on the first operation.
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
  static create({
    client,
    onRehydrationMiss,
  }: CreateClientOptions): AsyncResult<TypedClient, never> {
    const work = async () => {
      // `ensureConnected` exists on `Connection` (lazy gRPC channel);
      // mock/custom `ConnectionLike`s without it are accepted as-is.
      const connection = (client as { connection?: { ensureConnected?: () => Promise<void> } })
        .connection;
      if (connection && typeof connection.ensureConnected === "function") {
        try {
          await connection.ensureConnected();
        } catch (error) {
          // Technical connection fault — `makeAsyncResult`'s throw→defect
          // net routes it to the defect channel (never a modeled Err).
          // oxlint-disable-next-line unthrown/no-throw -- defect-channel routing: this throw inside the makeAsyncResult work thunk IS how a technical fault becomes a defect, never a modeled Err
          throw new TechnicalError("Failed to connect to Temporal server", error);
        }
      }

      return Ok(new TypedClient(client, onRehydrationMiss));
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
   * import { WORKFLOW_EXECUTE_PATTERNS } from "@temporal-contract/client";
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
   *     matcher.with(...WORKFLOW_EXECUTE_PATTERNS, (error) =>
   *       console.error("processing failed", error),
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
    const bound = ContractClient._internal_create(contract, this.raw, this.onRehydrationMiss);
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
 *
 * Workflow, signal and update names are constrained to the contract's
 * declarations at the type level; a name that slips past the types (a cast,
 * a raw call) is a defect carrying a {@link TechnicalError}, not a modeled
 * Err.
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
   * @example
   * ```ts
   * import {
   *   SCHEDULE_CREATE_PATTERNS,
   *   SCHEDULE_NOT_FOUND_ERROR_TAG,
   * } from "@temporal-contract/client";
   * import { P } from "unthrown";
   *
   * const result = await contractClient.schedule
   *   .create("processOrder", {
   *     scheduleId: "daily-sweep",
   *     spec: { cronExpressions: ["0 2 * * *"] },
   *     args: { orderId: "sweep" },
   *   })
   *   .flatMap((handle) => handle.pause("maintenance"));
   *
   * result.match({
   *   ok: () => console.log("schedule created, paused"),
   *   errCases: (matcher) =>
   *     matcher.with(...SCHEDULE_CREATE_PATTERNS, P.tag(SCHEDULE_NOT_FOUND_ERROR_TAG), (error) =>
   *       console.error("schedule setup failed", error),
   *     ),
   *   defect: (cause) => console.error("unexpected failure", cause),
   * });
   * ```
   */
  readonly schedule: TypedScheduleClient<TContract>;

  private readonly client: Client;
  private readonly onRehydrationMiss: OnRehydrationMiss | undefined;

  private constructor(
    contract: TContract,
    client: Client,
    onRehydrationMiss: OnRehydrationMiss | undefined,
  ) {
    this.contract = contract;
    this.client = client;
    this.onRehydrationMiss = onRehydrationMiss;
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
    onRehydrationMiss?: OnRehydrationMiss,
  ): ContractClient<TContract> {
    return new ContractClient(contract, client, onRehydrationMiss);
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
   * import { WORKFLOW_START_PATTERNS } from "@temporal-contract/client";
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
   *     matcher.with(...WORKFLOW_START_PATTERNS, (error) =>
   *       console.error('Failed to start:', error),
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
    WorkflowValidationError | WorkflowAlreadyStartedError
  > {
    return prepareStart(this.contract, workflowName, options as WidenedStartOptions).flatMap(
      ({ definition, startOptions }) =>
        call(
          "startWorkflow",
          this.client.workflow.start(workflowName, startOptions),
          classifyStartError,
        ).map((handle) =>
          createTypedHandle(
            handle,
            workflowName,
            definition as TContract["workflows"][TWorkflowName],
            // Not pinned to a run: the handle follows its chain.
            { firstExecutionRunId: handle.firstExecutionRunId },
            this.onRehydrationMiss,
          ),
        ),
    );
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
   *   WORKFLOW_START_PATTERNS,
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
   *       .with(...WORKFLOW_START_PATTERNS, (error) =>
   *         console.error('signalWithStart failed', error),
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
    WorkflowValidationError | SignalValidationError | WorkflowAlreadyStartedError
  > {
    const { signalName, signalArgs, ...start } = options as WidenedStartOptions & {
      signalName: string;
      signalArgs?: unknown;
    };
    return prepareStart(this.contract, workflowName, start).flatMap(
      ({ definition, startOptions }) => {
        const signalDef = lookupDeclared(
          definition.signals as Record<string, SignalDefinition> | undefined,
          signalName,
          "Signal",
          `workflow "${workflowName}"`,
        );
        // Like the workflow input, the parsed signal payload is discarded:
        // the signal handler parses on receive.
        return parseWithSchema(
          signalDef.input,
          signalArgs,
          (issues) => new SignalValidationError(signalName, issues),
        )
          .flatMap(() =>
            call(
              "signalWithStart",
              this.client.workflow.signalWithStart(workflowName, {
                ...startOptions,
                signal: signalName,
                // An omitted signal payload travels as empty signalArgs.
                signalArgs: (signalArgs === undefined ? [] : [signalArgs]) as unknown[],
              }),
              classifyStartError,
            ),
          )
          .map((handle) => ({
            ...createTypedHandle(
              handle,
              workflowName,
              definition as TContract["workflows"][TWorkflowName],
              {},
              this.onRehydrationMiss,
            ),
            signaledRunId: handle.signaledRunId,
          }));
      },
    );
  }

  /**
   * Execute a workflow (start and wait for result) with AsyncResult pattern —
   * `startWorkflow(...)` then `handle.result()`.
   *
   * Beside the start-phase errors, the result phase surfaces the workflow's
   * declared contract errors and the first-class outcome errors
   * (`WorkflowCancelledError` / `WorkflowTerminatedError` /
   * `WorkflowTimeoutError`) — see {@link TypedWorkflowHandle.result} for the
   * cancellation-handling caveat.
   *
   * @example
   * ```ts
   * import { CONTRACT_ERROR_TAG, WORKFLOW_EXECUTE_PATTERNS } from "@temporal-contract/client";
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
   *       .with(P.tag(CONTRACT_ERROR_TAG), (error) =>
   *         console.error('Domain failure:', error.errorName),
   *       )
   *       .with(...WORKFLOW_EXECUTE_PATTERNS, (error) =>
   *         console.error('Processing failed:', error),
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
    WorkflowResultErrorsOf<TContract["workflows"][TWorkflowName]> | WorkflowAlreadyStartedError
  > {
    return this.startWorkflow(workflowName, options).flatMap((handle) => handle.result());
  }

  /**
   * Start a workflow (or, under `workflowIdConflictPolicy: "USE_EXISTING"`,
   * reuse the running one) and send it an update in one request, waiting for
   * the update's result — Temporal's `executeUpdateWithStart`.
   *
   * Validates both the workflow input (`args`) and the update input
   * (`updateArgs`, for the update named by `updateName`) before anything is
   * sent, and parses the update's result against its output schema. To
   * reach the workflow afterwards, `getHandle` it by ID (`workflowIdFor` for
   * a derived ID).
   */
  executeUpdateWithStart<
    TWorkflowName extends keyof TContract["workflows"] & string,
    TUpdateName extends InferUpdateNames<TContract["workflows"][TWorkflowName]>,
  >(
    workflowName: TWorkflowName,
    options: TypedUpdateWithStartOptions<TContract, TWorkflowName, TUpdateName>,
  ): AsyncResult<
    ClientInferOutput<UpdateOf<TContract["workflows"][TWorkflowName], TUpdateName>>,
    | WorkflowValidationError
    | UpdateValidationError
    | WorkflowAlreadyStartedError
    | UpdateRejectedError
    | UpdateFailedError
    | UpdateRpcTimeoutOrCancelledError
  > {
    const {
      updateName,
      updateArgs: input,
      updateId,
      ...start
    } = options as WidenedStartOptions & {
      workflowIdConflictPolicy: WorkflowIdConflictPolicy;
      updateName: string;
      updateArgs?: unknown;
      updateId?: string;
    };
    return prepareStart(this.contract, workflowName, start).flatMap(
      ({ definition, startOptions }) => {
        const updateDef = lookupDeclared(
          definition.updates as Record<string, UpdateDefinition> | undefined,
          updateName,
          "Update",
          `workflow "${workflowName}"`,
        );
        return validateUpdateInput(updateName, updateDef, input).flatMap(() =>
          updateOutcome(
            "executeUpdateWithStart",
            this.client.workflow.executeUpdateWithStart(updateName, {
              args: updateArgs(input),
              ...(updateId !== undefined ? { updateId } : {}),
              startWorkflowOperation: new WithStartWorkflowOperation(
                workflowName,
                startOptions as WorkflowStartOptions & {
                  workflowIdConflictPolicy: WorkflowIdConflictPolicy;
                },
              ),
            }),
            updateName,
            updateDef,
            (error) => classifyStartError(error) ?? classifyUpdateError(error, updateName),
          ),
        );
      },
    ) as AsyncResult<
      ClientInferOutput<UpdateOf<TContract["workflows"][TWorkflowName], TUpdateName>>,
      | WorkflowValidationError
      | UpdateValidationError
      | WorkflowAlreadyStartedError
      | UpdateRejectedError
      | UpdateFailedError
      | UpdateRpcTimeoutOrCancelledError
    >;
  }

  /**
   * The workflow ID the contract derives for `input` — the same validation
   * and derivation a start runs, without starting anything. Use it to
   * `getHandle` an execution of a workflow whose contract declares
   * `workflowId`.
   *
   * Only callable for such workflows (the name is constrained at the type
   * level); invalid input is `Err(WorkflowValidationError)`.
   *
   * @example
   * ```ts
   * const handle = await orders
   *   .workflowIdFor("processOrder", { orderId: "ORD-1" })
   *   .map((workflowId) => orders.getHandle("processOrder", workflowId));
   * ```
   */
  workflowIdFor<TWorkflowName extends DerivedIdWorkflowName<TContract>>(
    workflowName: TWorkflowName,
    input: ClientInferInput<TContract["workflows"][TWorkflowName]>,
  ): AsyncResult<string, WorkflowValidationError> {
    return validateWorkflowInput(this.contract, workflowName, input, undefined).map(
      ({ definition, validatedInput }) => {
        const workflowId = deriveWorkflowId(definition, validatedInput);
        if (workflowId === undefined) {
          // oxlint-disable-next-line unthrown/no-throw -- defect-channel routing: the types only admit deriving workflows; this throw inside `map` becomes a defect
          throw new TechnicalError(`Workflow "${workflowName}" does not derive its workflow ID.`);
        }
        return workflowId;
      },
    );
  }

  /**
   * Get a typed handle to an existing workflow execution — synchronous and
   * infallible, like Temporal's `getHandle`. Whether the *execution* exists
   * is a server-side question answered lazily by the handle's methods (as
   * {@link WorkflowExecutionNotFoundError}).
   *
   * Accepts an optional `runId` (bind to a specific execution) and
   * Temporal's `firstExecutionRunId` — the chain interlock ensuring mutating
   * handle methods (`terminate`, `cancel`) don't affect executions from
   * another chain reusing the workflow ID.
   *
   * @example
   * ```ts
   * const handle = contractClient.getHandle('processOrder', 'order-123');
   * const result = await handle.result();
   * ```
   */
  getHandle<TWorkflowName extends keyof TContract["workflows"] & string>(
    workflowName: TWorkflowName,
    workflowId: string,
    options?: TypedGetHandleOptions,
  ): TypedWorkflowHandle<TContract["workflows"][TWorkflowName]> {
    const definition = lookupWorkflow(
      this.contract,
      workflowName,
    ) as TContract["workflows"][TWorkflowName];
    const { runId, ...handleOptions }: TypedGetHandleOptions = options ?? {};
    return createTypedHandle(
      this.client.workflow.getHandle(workflowId, runId, handleOptions),
      workflowName,
      definition,
      { runId, firstExecutionRunId: handleOptions.firstExecutionRunId },
      this.onRehydrationMiss,
    );
  }
}
