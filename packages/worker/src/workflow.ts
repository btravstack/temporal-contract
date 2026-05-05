// Entry point for workflow implementations.
//
// Workflows run inside Temporal's deterministic sandbox, which intercepts
// timers, randomness, and Promise scheduling for replay. neverthrow's
// `Result`/`ResultAsync` rely only on Promise scheduling, so they replay
// deterministically alongside Temporal's machinery. Activity code (see
// activity.ts) uses the same neverthrow API.
import type {
  ActivityDefinition,
  ContractDefinition,
  QueryDefinition,
  QueryNamesOf,
  SignalDefinition,
  SignalNamesOf,
  UpdateDefinition,
  UpdateNamesOf,
} from "@temporal-contract/contract";
import {
  ChildWorkflowCancelledError,
  ChildWorkflowError,
  ChildWorkflowNotFoundError,
  WorkflowCancelledError,
  WorkflowInputValidationError,
  WorkflowOutputValidationError,
  WorkflowScopeError,
} from "./errors.js";
import { cancellableScope, nonCancellableScope } from "./cancellation.js";
import {
  bindQueryHandler,
  bindSignalHandler,
  bindUpdateHandler,
  type QueryHandlerImplementation,
  type SignalHandlerImplementation,
  type UpdateHandlerImplementation,
} from "./handlers.js";
import {
  ClientInferInput,
  ClientInferOutput,
  WorkerInferInput,
  WorkerInferOutput,
} from "./types.js";
import type { ResultAsync } from "neverthrow";
import {
  buildRawActivitiesProxy,
  createContinueAsNew,
  extractHandlerInput,
  type TypedContinueAsNewOptions,
} from "./internal.js";
import {
  createStartChildWorkflow,
  createExecuteChildWorkflow,
  type TypedChildWorkflowHandle,
  type TypedChildWorkflowOptions,
} from "./child-workflow.js";
import {
  createValidatedActivities,
  type WorkflowInferWorkflowContextActivities,
} from "./activities-proxy.js";
import { ActivityOptions, WorkflowInfo, workflowInfo } from "@temporalio/workflow";

export {
  ActivityInputValidationError,
  ActivityOutputValidationError,
  ChildWorkflowCancelledError,
  ChildWorkflowError,
  ChildWorkflowNotFoundError,
  QueryInputValidationError,
  QueryOutputValidationError,
  SignalInputValidationError,
  UpdateInputValidationError,
  UpdateOutputValidationError,
  WorkflowCancelledError,
  WorkflowInputValidationError,
  WorkflowOutputValidationError,
  WorkflowScopeError,
} from "./errors.js";

/**
 * Create a typed workflow implementation with automatic validation
 *
 * This wraps a workflow implementation with:
 * - Input/output validation
 * - Typed workflow context with activities
 * - Workflow info access
 *
 * Workflows must be defined in separate files and imported by the Temporal Worker
 * via workflowsPath.
 *
 * @example
 * ```ts
 * // workflows/processOrder.ts
 * import { declareWorkflow } from '@temporal-contract/worker/workflow';
 * import myContract from '../contract';
 *
 * export const processOrder = declareWorkflow({
 *   workflowName: 'processOrder',
 *   contract: myContract,
 *   activityOptions: {
 *     startToCloseTimeout: '1 minute',
 *   },
 *   // Optional: override `activityOptions` for specific activities. Each
 *   // entry shallow-merges over the workflow default — the override wins on
 *   // every property it specifies, including the whole `retry` block.
 *   activityOptionsByName: {
 *     chargePayment: {
 *       startToCloseTimeout: '5 minutes',
 *       retry: { maximumAttempts: 5 },
 *     },
 *   },
 *   implementation: async (context, args) => {
 *     // context.activities: typed activities (workflow + global)
 *     // context.info: WorkflowInfo
 *
 *     const inventory = await context.activities.validateInventory({
 *       orderId: args.orderId,
 *     });
 *
 *     if (!inventory.available) {
 *       return { orderId: args.orderId, status: 'out_of_stock' };
 *     }
 *
 *     const payment = await context.activities.chargePayment({
 *       customerId: args.customerId,
 *       amount: 100,
 *     });
 *
 *     return {
 *       orderId: args.orderId,
 *       status: payment.success ? 'success' : 'failed',
 *       transactionId: payment.transactionId,
 *     };
 *   },
 * });
 * ```
 *
 * Then in your worker setup:
 * ```ts
 * // worker.ts
 * import { createWorker } from '@temporal-contract/worker/worker';
 * import { activities } from './activities';
 * import myContract from './contract';
 *
 * const worker = await createWorker({
 *   contract: myContract,
 *   connection,
 *   workflowsPath: workflowsPathFromURL(import.meta.url, './workflows.js'),
 *   activities,
 * });
 * ```
 */
export function declareWorkflow<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
>({
  workflowName,
  contract,
  implementation,
  activityOptions,
  activityOptionsByName,
}: DeclareWorkflowOptions<TContract, TWorkflowName>): (
  ...args: unknown[]
) => Promise<WorkerInferOutput<TContract["workflows"][TWorkflowName]>> {
  // Get the workflow definition from the contract
  const definition = contract.workflows[workflowName] as TContract["workflows"][TWorkflowName];

  // Build the activities proxy *once* at declaration time, not per workflow
  // invocation. Temporal's `proxyActivities` is documented as a module-scope
  // helper — it registers stub functions and may carry bookkeeping
  // (validator pre-registration, payload-converter caching) that breaks if
  // re-invoked on every workflow run. The call depends only on contract-time
  // immutables (`definition.activities`, `contract.activities`,
  // `activityOptions`, `activityOptionsByName`), all of which are available
  // here, so hoisting is safe and deterministic.
  //
  // The validation wrapper (`createValidatedActivities`) is stateless across
  // invocations — it merely closes over the activity definitions and the raw
  // proxy, both immutable — so it is hoisted alongside the proxy. The
  // resulting `contextActivities` object is shared by every workflow run,
  // which is fine because the wrapped activity functions take their input
  // as an argument and validate it per-call (no closed-over per-invocation
  // state).
  //
  // Design note — intentional double-validation:
  // Input and output are validated here (workflow side) AND again inside
  // `declareActivitiesHandler` (activity worker side). This is deliberate:
  //
  // 1. Workflow-side validation catches bad data *before* it crosses the
  //    task-queue network boundary, giving an early, descriptive error
  //    instead of a confusing deserialization failure inside the activity.
  // 2. Activity-side validation is the authoritative guard, since the
  //    activity may be called by other callers that do not use this library.
  //
  // The overhead is minimal relative to the network round-trip.
  let contextActivities: unknown = {};

  if (definition.activities || contract.activities) {
    const rawActivities = buildRawActivitiesProxy(
      definition.activities,
      contract.activities,
      activityOptions,
      activityOptionsByName,
    );

    contextActivities = createValidatedActivities(
      rawActivities,
      definition.activities,
      contract.activities,
    );

    // Shared across workflow invocations after the proxyActivities hoist
    // (PR #211); freeze so user code can't mutate one invocation's view of
    // activities and have it leak into others. The freeze is shallow, which
    // is sufficient because `createValidatedActivities` returns a flat
    // `{ [name]: (input) => Promise<output> }` map — every value is a
    // stateless validation wrapper function, not a nested object users could
    // reach into. The matching `Readonly<...>` on `WorkflowContext.activities`
    // surfaces the immutability at the type level.
    Object.freeze(contextActivities);
  }

  return async (...args: unknown[]) => {
    const input = extractHandlerInput(args);

    // Validate workflow input
    const inputResult = await definition.input["~standard"].validate(input);
    if (inputResult.issues) {
      throw new WorkflowInputValidationError(workflowName, inputResult.issues);
    }
    const validatedInput = inputResult.value as WorkerInferInput<
      TContract["workflows"][TWorkflowName]
    >;

    // Create workflow context.
    //
    // The defineSignal / defineQuery / defineUpdate arrows forward to the
    // hoisted helpers in `./handlers.ts`. The arrows themselves are thin
    // closures that close over `definition` and `workflowName`; the heavy
    // logic — runtime guards, validation, Temporal `defineSignal/Query/
    // Update` + `setHandler` wiring — lives at module scope so it isn't
    // reallocated on each workflow invocation.
    //
    // The cast at each assignment preserves the typed call-site surface
    // (the `K extends keyof ...` constraints declared on
    // `WorkflowContext.defineSignal/Query/Update`), while the helpers
    // themselves take loosely-typed arguments at the runtime boundary.
    const context: WorkflowContext<TContract, TWorkflowName> = {
      activities: contextActivities as WorkflowInferWorkflowContextActivities<
        TContract,
        TWorkflowName
      >,
      info: workflowInfo(),
      startChildWorkflow: createStartChildWorkflow,
      executeChildWorkflow: createExecuteChildWorkflow,
      cancellableScope,
      nonCancellableScope,
      defineSignal: ((signalName, handler) =>
        bindSignalHandler(
          definition,
          workflowName,
          signalName,
          handler as unknown as SignalHandlerImplementation<SignalDefinition>,
        )) as WorkflowContext<TContract, TWorkflowName>["defineSignal"],
      defineQuery: ((queryName, handler) =>
        bindQueryHandler(
          definition,
          workflowName,
          queryName,
          handler as unknown as QueryHandlerImplementation<QueryDefinition>,
        )) as WorkflowContext<TContract, TWorkflowName>["defineQuery"],
      defineUpdate: ((updateName, handler) =>
        bindUpdateHandler(
          definition,
          workflowName,
          updateName,
          handler as unknown as UpdateHandlerImplementation<UpdateDefinition>,
        )) as WorkflowContext<TContract, TWorkflowName>["defineUpdate"],
      continueAsNew: createContinueAsNew(contract, workflowName) as WorkflowContext<
        TContract,
        TWorkflowName
      >["continueAsNew"],
    };

    // Execute workflow (pass validated input as tuple)
    const result = await implementation(context, validatedInput);

    // Validate workflow output
    const outputResult = await definition.output["~standard"].validate(result);
    if (outputResult.issues) {
      throw new WorkflowOutputValidationError(workflowName, outputResult.issues);
    }

    return outputResult.value as WorkerInferOutput<TContract["workflows"][TWorkflowName]>;
  };
}

/**
 * Union of all activity names available to a workflow — the workflow-local
 * activities plus the contract's global activities.
 */
type ActivityNamesFor<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
> =
  | (TContract["workflows"][TWorkflowName]["activities"] extends Record<string, ActivityDefinition>
      ? keyof TContract["workflows"][TWorkflowName]["activities"] & string
      : never)
  | (TContract["activities"] extends Record<string, ActivityDefinition>
      ? keyof TContract["activities"] & string
      : never);

/**
 * Options for declaring a workflow implementation
 */
type DeclareWorkflowOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
> = {
  workflowName: TWorkflowName;
  contract: TContract;
  implementation: WorkflowImplementation<TContract, TWorkflowName>;
  /**
   * Default activity options applied to every activity reachable from this
   * workflow (workflow-local + global) unless overridden in
   * {@link activityOptionsByName}. See Temporal's `ActivityOptions` for the
   * full set of fields:
   * - `startToCloseTimeout`: Maximum time for a single attempt to run
   * - `scheduleToCloseTimeout`: End-to-end timeout including queuing and retries
   * - `scheduleToStartTimeout`: Maximum time the activity can wait in the queue
   * - `heartbeatTimeout`: Time between heartbeats before the activity is considered dead
   * - `retry`: Retry policy for failed activities
   *
   * @example
   * ```ts
   * activityOptions: {
   *   startToCloseTimeout: '5m',
   *   retry: { maximumAttempts: 3 },
   * }
   * ```
   */
  activityOptions: ActivityOptions;
  /**
   * Per-activity `ActivityOptions` overrides. Each entry shallow-merges over
   * {@link activityOptions} for that activity only — the override wins on
   * every property it specifies, replacing the default value (including the
   * entire nested `retry` block when present, matching Temporal's
   * single-options-per-`proxyActivities`-call semantics).
   *
   * Activity names are typed against the contract; typos surface as TypeScript
   * errors rather than running silently with the default options.
   *
   * @example
   * ```ts
   * activityOptions: { startToCloseTimeout: '1 minute' }, // default
   * activityOptionsByName: {
   *   chargePayment: {
   *     startToCloseTimeout: '5 minutes',
   *     retry: { maximumAttempts: 5 },
   *   },
   *   fastValidation: { startToCloseTimeout: '5 seconds' },
   * },
   * ```
   */
  activityOptionsByName?: Partial<
    Record<ActivityNamesFor<TContract, TWorkflowName>, ActivityOptions>
  >;
};

/**
 * Workflow implementation function
 *
 * Receives a workflow context (with typed activities and utilities) and validated input arguments.
 * Returns the workflow output which will be validated against the contract schema.
 */
type WorkflowImplementation<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
> = (
  context: WorkflowContext<TContract, TWorkflowName>,
  args: WorkerInferInput<TContract["workflows"][TWorkflowName]>,
) => Promise<WorkerInferOutput<TContract["workflows"][TWorkflowName]>>;

/**
 * Workflow execution context providing typed activities, workflow info, and interaction handlers
 *
 * Provides access to:
 * - Typed activities (both workflow-specific and global)
 * - Workflow metadata and execution info
 * - Signal, query, and update handler registration
 * - Child workflow execution capabilities
 */
type WorkflowContext<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
> = {
  activities: Readonly<WorkflowInferWorkflowContextActivities<TContract, TWorkflowName>>;
  info: WorkflowInfo;

  /**
   * Define a signal handler within the workflow implementation
   * Allows the signal handler to access workflow state
   *
   * @example
   * ```ts
   * implementation: async (context, args) => {
   *   let currentValue = args.initialValue;
   *
   *   context.defineSignal('increment', async (signalArgs) => {
   *     currentValue += signalArgs.amount;
   *   });
   *
   *   // ... rest of workflow
   * }
   * ```
   */
  defineSignal: <K extends SignalNamesOf<TContract["workflows"][TWorkflowName]>>(
    signalName: K,
    handler: SignalHandlerImplementation<
      NonNullable<TContract["workflows"][TWorkflowName]["signals"]> extends Record<
        string,
        SignalDefinition
      >
        ? NonNullable<TContract["workflows"][TWorkflowName]["signals"]>[K] extends SignalDefinition
          ? NonNullable<TContract["workflows"][TWorkflowName]["signals"]>[K]
          : never
        : never
    >,
  ) => void;

  /**
   * Define a query handler within the workflow implementation
   * Allows the query handler to access workflow state
   *
   * @example
   * ```ts
   * implementation: async (context, args) => {
   *   let currentValue = args.initialValue;
   *
   *   context.defineQuery('getCurrentValue', () => {
   *     return { value: currentValue };
   *   });
   *
   *   // ... rest of workflow
   * }
   * ```
   */
  defineQuery: <K extends QueryNamesOf<TContract["workflows"][TWorkflowName]>>(
    queryName: K,
    handler: QueryHandlerImplementation<
      NonNullable<TContract["workflows"][TWorkflowName]["queries"]> extends Record<
        string,
        QueryDefinition
      >
        ? NonNullable<TContract["workflows"][TWorkflowName]["queries"]>[K] extends QueryDefinition
          ? NonNullable<TContract["workflows"][TWorkflowName]["queries"]>[K]
          : never
        : never
    >,
  ) => void;

  /**
   * Define an update handler within the workflow implementation
   * Allows the update handler to access and modify workflow state
   *
   * @example
   * ```ts
   * implementation: async (context, args) => {
   *   let currentValue = args.initialValue;
   *
   *   context.defineUpdate('multiply', async (updateArgs) => {
   *     currentValue *= updateArgs.factor;
   *     return { newValue: currentValue };
   *   });
   *
   *   // ... rest of workflow
   * }
   * ```
   */
  defineUpdate: <K extends UpdateNamesOf<TContract["workflows"][TWorkflowName]>>(
    updateName: K,
    handler: UpdateHandlerImplementation<
      NonNullable<TContract["workflows"][TWorkflowName]["updates"]> extends Record<
        string,
        UpdateDefinition
      >
        ? NonNullable<TContract["workflows"][TWorkflowName]["updates"]>[K] extends UpdateDefinition
          ? NonNullable<TContract["workflows"][TWorkflowName]["updates"]>[K]
          : never
        : never
    >,
  ) => void;

  /**
   * Start a child workflow and return a typed handle with ResultAsync pattern
   *
   * Supports both same-contract and cross-contract child workflows:
   * - Same contract: Pass workflowName from current contract
   * - Cross-contract: Pass contract and workflowName to invoke workflows from other workers
   *
   * @example
   * ```ts
   * // Same contract child workflow
   * const childResult = await context.startChildWorkflow(myContract, 'processPayment', {
   *   workflowId: 'payment-123',
   *   args: { amount: 100 }
   * });
   *
   * // Cross-contract child workflow (from another worker)
   * const otherResult = await context.startChildWorkflow(otherContract, 'sendNotification', {
   *   workflowId: 'notification-123',
   *   args: { message: 'Hello' }
   * });
   *
   * childResult.match(
   *   async (handle) => {
   *     const result = await handle.result();
   *     // ... handle result
   *   },
   *   (error) => console.error('Failed to start:', error),
   * );
   * ```
   */
  startChildWorkflow: <
    TChildContract extends ContractDefinition,
    TChildWorkflowName extends keyof TChildContract["workflows"] & string,
  >(
    contract: TChildContract,
    workflowName: TChildWorkflowName,
    options: TypedChildWorkflowOptions<TChildContract, TChildWorkflowName>,
  ) => ResultAsync<
    TypedChildWorkflowHandle<TChildContract["workflows"][TChildWorkflowName]>,
    ChildWorkflowError | ChildWorkflowCancelledError | ChildWorkflowNotFoundError
  >;

  /**
   * Execute a child workflow (start and wait for result) with ResultAsync pattern
   *
   * Supports both same-contract and cross-contract child workflows:
   * - Same contract: Pass workflowName from current contract
   * - Cross-contract: Pass contract and workflowName to invoke workflows from other workers
   *
   * @example
   * ```ts
   * // Same contract child workflow
   * const result = await context.executeChildWorkflow(myContract, 'processPayment', {
   *   workflowId: 'payment-123',
   *   args: { amount: 100 }
   * });
   *
   * // Cross-contract child workflow (from another worker)
   * const otherResult = await context.executeChildWorkflow(otherContract, 'sendNotification', {
   *   workflowId: 'notification-123',
   *   args: { message: 'Hello' }
   * });
   *
   * result.match(
   *   (output) => console.log('Payment processed:', output),
   *   (error) => console.error('Processing failed:', error),
   * );
   * ```
   */
  executeChildWorkflow: <
    TChildContract extends ContractDefinition,
    TChildWorkflowName extends keyof TChildContract["workflows"] & string,
  >(
    contract: TChildContract,
    workflowName: TChildWorkflowName,
    options: TypedChildWorkflowOptions<TChildContract, TChildWorkflowName>,
  ) => ResultAsync<
    ClientInferOutput<TChildContract["workflows"][TChildWorkflowName]>,
    ChildWorkflowError | ChildWorkflowCancelledError | ChildWorkflowNotFoundError
  >;

  /**
   * Run `fn` inside a cancellable Temporal scope. If the workflow (or an
   * ancestor scope) is cancelled while `fn` is in flight, the resulting
   * ResultAsync resolves to `err(WorkflowCancelledError)` instead of
   * rejecting — letting callers handle cancellation explicitly, typically
   * to perform a graceful exit from the current step.
   *
   * Non-cancellation errors thrown by `fn` resolve to
   * `err(WorkflowScopeError)` (with the original error preserved on
   * `cause`). Both failure modes ride neverthrow's railway, so
   * `result.match(...)` is exhaustive — nothing escapes as an unhandled
   * rejection.
   *
   * @example
   * ```ts
   * implementation: async (context, args) => {
   *   const result = await context.cancellableScope(async () => {
   *     return context.activities.processStep(args);
   *   });
   *
   *   if (result.isErr()) {
   *     if (result.error instanceof WorkflowCancelledError) {
   *       // workflow was cancelled — perform cleanup that must not be cancelled:
   *       await context.nonCancellableScope(async () => {
   *         await context.activities.releaseResources(args);
   *       });
   *       return { status: "cancelled" };
   *     }
   *     // result.error instanceof WorkflowScopeError — domain failure
   *     return { status: "failed" };
   *   }
   *
   *   return { status: "ok" };
   * }
   * ```
   */
  cancellableScope: <T>(
    fn: () => T | Promise<T>,
  ) => ResultAsync<T, WorkflowCancelledError | WorkflowScopeError>;

  /**
   * Run `fn` inside a non-cancellable Temporal scope. Cancellation requests
   * from outside the scope are ignored for its duration — the idiomatic way
   * to perform cleanup work that must not be interrupted.
   *
   * Returns the same `ResultAsync<...>` shape as
   * {@link WorkflowContext.cancellableScope} for symmetry; the
   * `err(WorkflowCancelledError)` branch only triggers when cancellation is
   * raised from *inside* the scope, which is rare. Non-cancellation errors
   * surface as `err(WorkflowScopeError)`.
   */
  nonCancellableScope: <T>(
    fn: () => T | Promise<T>,
  ) => ResultAsync<T, WorkflowCancelledError | WorkflowScopeError>;

  /**
   * Continue this workflow execution as a new run, optionally with a different
   * workflow type from another contract.
   *
   * Args are validated against the destination workflow's input schema before
   * Temporal's `continueAsNew` is invoked. On validation failure, throws a
   * {@link WorkflowInputValidationError}; on success, Temporal terminates the
   * current execution and starts a fresh one — which is why the function
   * never returns normally (`Promise<never>`).
   *
   * Idiomatic usage:
   *
   * @example
   * ```ts
   * // Same workflow, validated args
   * implementation: async (context, args) => {
   *   if (shouldRoll(args)) {
   *     return context.continueAsNew({ ...args, retryCount: args.retryCount + 1 });
   *   }
   *   return ...;
   * }
   *
   * // Cross-contract continueAsNew (less common — taskQueue and workflow type
   * // come from the other contract)
   * return context.continueAsNew(otherContract, "otherWorkflow", { ...newArgs });
   * ```
   */
  continueAsNew: {
    /** Same-workflow continuation — args typed against this workflow's input. */
    (
      args: ClientInferInput<TContract["workflows"][TWorkflowName]>,
      options?: TypedContinueAsNewOptions,
    ): Promise<never>;
    /** Cross-contract continuation — args typed against the destination workflow. */
    <
      TOtherContract extends ContractDefinition,
      TOtherWorkflowName extends keyof TOtherContract["workflows"] & string,
    >(
      contract: TOtherContract,
      workflowName: TOtherWorkflowName,
      args: ClientInferInput<TOtherContract["workflows"][TOtherWorkflowName]>,
      options?: TypedContinueAsNewOptions,
    ): Promise<never>;
  };
};
