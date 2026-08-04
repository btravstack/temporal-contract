// Entry point for workflow implementations.
//
// Workflows run inside Temporal's deterministic sandbox, which intercepts
// timers, randomness, and Promise scheduling for replay. unthrown's
// `Result`/`AsyncResult` rely only on Promise scheduling, so they replay
// deterministically alongside Temporal's machinery. Activity code (see
// activity.ts) uses the same unthrown API.
import type {
  ActivityDefinition,
  ContractDefinition,
  ErrorDefinition,
  InferQueryNames,
  InferSignalNames,
  InferUpdateNames,
  QueryDefinition,
  SignalDefinition,
  UpdateDefinition,
} from "@temporal-contract/contract";
import { ContractError, type ContractErrorConstructors } from "@temporal-contract/contract/errors";
import { _internal_buildErrorConstructors } from "@temporal-contract/contract/internal";
import { type ActivityOptions, type WorkflowInfo, workflowInfo } from "@temporalio/workflow";
import type { AsyncResult } from "unthrown";

import {
  createValidatedActivities,
  type WorkflowInferWorkflowContextActivities,
} from "./activities-proxy.js";
import { cancellableScope, nonCancellableScope } from "./cancellation.js";
import {
  createStartChildWorkflow,
  createExecuteChildWorkflow,
  type TypedChildWorkflowHandle,
  type TypedChildWorkflowOptions,
} from "./child-workflow.js";
import { contractErrorToApplicationFailure } from "./contract-errors.js";
import {
  type ChildWorkflowCancelledError,
  type ChildWorkflowError,
  type ChildWorkflowNotFoundError,
  ContractMisuseError,
  type WorkflowCancelledError,
  WorkflowInputValidationError,
  WorkflowOutputValidationError,
} from "./errors.js";
import {
  bindQueryHandler,
  bindSignalHandler,
  bindUpdateHandler,
  type QueryHandlerImplementation,
  type SignalHandlerImplementation,
  type UpdateHandlerImplementation,
} from "./handlers.js";
import {
  buildRawActivitiesProxy,
  createContinueAsNew,
  extractHandlerInput,
  type TypedContinueAsNewOptions,
} from "./internal.js";
import {
  type ClientInferInput,
  type ClientInferOutput,
  type QueryDefOf,
  type SignalDefOf,
  type UpdateDefOf,
  type WorkerInferInput,
  type WorkerInferOutput,
} from "./types.js";
import { DECLARED_WORKFLOW_BRAND } from "./workflow-brand.js";

export {
  ActivityCancelledError,
  ActivityError,
  ActivityInputValidationError,
  ActivityOutputValidationError,
  ChildWorkflowCancelledError,
  ChildWorkflowError,
  ChildWorkflowNotFoundError,
  ContractErrorDataValidationError,
  ContractMisuseError,
  QueryInputValidationError,
  QueryOutputValidationError,
  UpdateInputValidationError,
  UpdateOutputValidationError,
  ValidationError,
  WorkflowCancelledError,
  WorkflowInputValidationError,
  WorkflowOutputValidationError,
} from "./errors.js";

// Re-export the typed contract-error surface so workflow code can
// `instanceof`-check rehydrated activity errors and type against the
// constructors without a separate `@temporal-contract/contract/errors`
// import.
export {
  ContractError,
  type AnyContractError,
  type ContractErrorConstructors,
  type ContractErrorOptions,
  type ContractErrorUnion,
} from "@temporal-contract/contract/errors";

// Cancellation re-raise helper: cancellation surfaces on the modeled
// `Err(...)` channel, which generic error handling can swallow (turning a
// server-side cancel into a `Completed` outcome). `rethrowCancellation`
// re-raises the original CancelledFailure so the execution ends `Cancelled`.
export { rethrowCancellation } from "./errors.js";

// Activity-failure re-raise helper: the workflow-side equivalent of "let it
// fail" for any activity call's `AsyncResult` — declared `errors` map or not.
// Re-raises the original Temporal failure (not the
// `ActivityError`/`ActivityCancelledError` wrapper, which isn't a
// `TemporalFailure`) so Temporal classifies the workflow outcome exactly as
// it would have if the activity call still threw directly.
export { propagateActivityFailure } from "./activity-failure.js";

// Literal-typed `_tag` constants for this package's tagged errors, so
// consumers can `P.tag(ACTIVITY_ERROR_TAG)` without hand-writing the
// namespaced strings (mirrors the contract package's error-tags module).
export {
  ACTIVITY_CANCELLED_ERROR_TAG,
  ACTIVITY_DEFINITION_NOT_FOUND_ERROR_TAG,
  ACTIVITY_ERROR_TAG,
  CHILD_WORKFLOW_CANCELLED_ERROR_TAG,
  CHILD_WORKFLOW_ERROR_TAG,
  CHILD_WORKFLOW_NOT_FOUND_ERROR_TAG,
  WORKFLOW_CANCELLED_ERROR_TAG,
} from "./error-tags.js";

// Public child-workflow types: the handle returned by
// `context.startChildWorkflow`, its options bag, and the typed signal-sender
// map — exported so user code can annotate stored handles and helpers.
export type {
  TypedChildWorkflowHandle,
  TypedChildWorkflowOptions,
  TypedChildWorkflowSignals,
} from "./child-workflow.js";

// Public handler-implementation types for `context.handleSignal` /
// `handleQuery` / `handleUpdate`, so handlers can be declared standalone.
export type {
  QueryHandlerImplementation,
  SignalHandlerImplementation,
  UpdateHandlerImplementation,
} from "./handlers.js";

// Public activity-inference types: the workflow-side shape of a single
// activity and of the full `context.activities` map, plus the error union
// (`ActivityErrorsFor`) that `WorkflowInferActivity` uses for its `AsyncResult`
// error channel — exported so consumers can name it directly, e.g. to write a
// helper generic over an activity's error type.
export type {
  ActivityErrorsFor,
  WorkflowInferActivity,
  WorkflowInferWorkflowContextActivities,
} from "./activities-proxy.js";

// Continue-as-new options type referenced by `WorkflowContext.continueAsNew`.
export type { TypedContinueAsNewOptions } from "./internal.js";

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
 * import myContract from '../contract.js';
 *
 * export const processOrder = declareWorkflow({
 *   workflowName: 'processOrder',
 *   contract: myContract,
 *   activityOptions: {
 *     startToCloseTimeout: '1 minute',
 *     retry: { maximumAttempts: 3 },
 *   },
 *   // Optional: override `activityOptions` for specific activities. Each
 *   // entry shallow-merges over the workflow default — the override wins on
 *   // every property it specifies, including the whole `retry` block. The
 *   // override is Temporal's full `ActivityOptions`, so `taskQueue` works too,
 *   // letting you route individual activities to a dedicated worker pool.
 *   //
 *   // Every reachable activity's MERGED options need both a per-attempt bound
 *   // (`startToCloseTimeout` or `scheduleToCloseTimeout`) and a total bound
 *   // (`scheduleToCloseTimeout`, or a finite positive `retry.maximumAttempts`)
 *   // — the workflow default above supplies both, so `scoreRisk` below only
 *   // needs to override what it's actually changing (`taskQueue`).
 *   activityOptionsByName: {
 *     chargePayment: {
 *       startToCloseTimeout: '5 minutes',
 *       retry: { maximumAttempts: 5 },
 *     },
 *     // Route this activity to a dedicated, concurrency-capped queue; it
 *     // still inherits the workflow default's bounds (only `taskQueue` is
 *     // overridden here).
 *     scoreRisk: { taskQueue: 'ml-inference' },
 *   },
 *   implementation: async (context, args) => {
 *     // context.activities: typed activities (workflow + global)
 *     // context.info: WorkflowInfo
 *
 *     // Every activity call returns an AsyncResult with three channels —
 *     // narrow `isDefect()`/`isErr()` (or use `propagateActivityFailure` to
 *     // let Temporal decide the outcome) before reaching `.value`.
 *     const inventory = await context.activities.validateInventory({
 *       orderId: args.orderId,
 *     });
 *     if (inventory.isDefect()) throw inventory.cause;
 *     if (inventory.isErr()) {
 *       return { orderId: args.orderId, status: 'out_of_stock' };
 *     }
 *
 *     if (!inventory.value.available) {
 *       return { orderId: args.orderId, status: 'out_of_stock' };
 *     }
 *
 *     const payment = await context.activities.chargePayment({
 *       customerId: args.customerId,
 *       amount: 100,
 *     });
 *     if (payment.isDefect()) throw payment.cause;
 *     if (payment.isErr()) {
 *       return { orderId: args.orderId, status: 'failed' };
 *     }
 *
 *     return {
 *       orderId: args.orderId,
 *       status: payment.value.success ? 'success' : 'failed',
 *       transactionId: payment.value.transactionId,
 *     };
 *   },
 * });
 * ```
 *
 * Then in your worker setup:
 * ```ts
 * // worker.ts
 * import { TypedWorker, workflowsPathFromURL } from '@temporal-contract/worker/worker';
 * import { activities } from './activities.js';
 * import myContract from './contract.js';
 *
 * // `TypedWorker.create` returns AsyncResult<TypedWorker, never> — setup
 * // failures ride the defect channel, so `.get()` unwraps directly.
 * const worker = await TypedWorker.create({
 *   contract: myContract,
 *   connection,
 *   workflowsPath: workflowsPathFromURL(import.meta.url, './workflows.js'),
 *   activities,
 * }).get();
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
  // Get the workflow definition from the contract. The runtime guard covers
  // JavaScript callers and stale casts the type system can't see — without
  // it, a typo'd `workflowName` would crash later with an opaque
  // `Cannot read properties of undefined (reading 'activities')`. This runs
  // at declaration time in the workflow bundle (module top level, before
  // Temporal ever invokes the workflow function), so throwing
  // `ContractMisuseError` here does NOT avoid the D3 fate the way it does
  // for a misuse caught from inside a running `implementation` (e.g. an
  // undeclared handler name) — the SDK's outer activation handler turns any
  // throw at this point into a Workflow Task failure regardless of the
  // error class, so it still stalls via indefinite workflow-task retry,
  // same as a plain `Error` would. The value of `ContractMisuseError` here
  // is a named, greppable failure with the offending name and the
  // contract's available workflows, not a bare property-access crash — not
  // a different runtime outcome. See `activity-bounds.ts` for the fuller
  // explanation of this same distinction.
  const definition = contract.workflows[workflowName] as
    | TContract["workflows"][TWorkflowName]
    | undefined;
  if (!definition) {
    const available = Object.keys(contract.workflows).join(", ") || "none";
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: declaration-time fail-fast as a non-retryable ApplicationFailure (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(
      `declareWorkflow: workflow "${String(workflowName)}" is not declared on the supplied contract. Available workflows: ${available}`,
    );
  }

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
  // Design note — wire format (validate on send, parse on receive):
  // Each activity payload boundary is parsed exactly once, on the receiving
  // side, so a transforming schema (`z.coerce.*`, `.transform(...)`) is
  // never applied twice:
  //
  // 1. The workflow-side wrapper (`createValidatedActivities`) VALIDATES the
  //    input it is about to send — catching bad data *before* it crosses the
  //    task-queue network boundary with an early, descriptive error — but
  //    transmits the caller's ORIGINAL value, discarding the parsed result.
  // 2. `declareActivitiesHandler` (activity worker side) PARSES the payload
  //    on receive; it is the authoritative guard, since the activity may be
  //    called by other callers that do not use this library.
  //
  // The activity result flows the other way: the activity side validates its
  // return and hands Temporal the original value; the wrapper here parses it
  // on receive. The extra send-side validation overhead is minimal relative
  // to the network round-trip.
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

  // Typed constructors for the workflow's declared contract errors —
  // stateless and derived from contract-time immutables, so hoisted to
  // declaration time alongside the activities proxy.
  const workflowErrorConstructors = _internal_buildErrorConstructors(definition.errors);

  const workflowFn = async (...args: unknown[]) => {
    const input = extractHandlerInput(args);

    // Parse workflow input. This is the RECEIVING side of the input
    // boundary: the typed client validated the args but transmitted the
    // caller's original value, so the parse (and any schema transform)
    // happens exactly once, here.
    const inputResult = await definition.input["~standard"].validate(input);
    if (inputResult.issues) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new WorkflowInputValidationError(workflowName, inputResult.issues);
    }
    const validatedInput = inputResult.value as WorkerInferInput<
      TContract["workflows"][TWorkflowName]
    >;

    // Create workflow context.
    //
    // The handleSignal / handleQuery / handleUpdate arrows forward to the
    // hoisted helpers in `./handlers.ts`. The arrows themselves are thin
    // closures that close over `definition` and `workflowName`; the heavy
    // logic — runtime guards, validation, Temporal `defineSignal/Query/
    // Update` + `setHandler` wiring — lives at module scope so it isn't
    // reallocated on each workflow invocation.
    //
    // The cast at each assignment preserves the typed call-site surface
    // (the `K extends keyof ...` constraints declared on
    // `WorkflowContext.handleSignal/Query/Update`), while the helpers
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
      handleSignal: ((signalName, handler) =>
        bindSignalHandler(
          definition,
          workflowName,
          signalName,
          handler as unknown as SignalHandlerImplementation<SignalDefinition>,
        )) as WorkflowContext<TContract, TWorkflowName>["handleSignal"],
      handleQuery: ((queryName, handler) =>
        bindQueryHandler(
          definition,
          workflowName,
          queryName,
          handler as unknown as QueryHandlerImplementation<QueryDefinition>,
        )) as WorkflowContext<TContract, TWorkflowName>["handleQuery"],
      handleUpdate: ((updateName, handler) =>
        bindUpdateHandler(
          definition,
          workflowName,
          updateName,
          handler as unknown as UpdateHandlerImplementation<UpdateDefinition>,
        )) as WorkflowContext<TContract, TWorkflowName>["handleUpdate"],
      continueAsNew: createContinueAsNew(contract, workflowName) as WorkflowContext<
        TContract,
        TWorkflowName
      >["continueAsNew"],
      errors: workflowErrorConstructors as WorkflowContext<TContract, TWorkflowName>["errors"],
    };

    // Execute workflow with the parsed input.
    //
    // A thrown typed contract error (`throw context.errors.X(...)`) is
    // converted to its `ApplicationFailure` wire shape here. This must
    // happen inside the workflow function: a plain `Error` subclass thrown
    // from workflow code is treated by Temporal as a Workflow Task failure
    // and retried forever, while an `ApplicationFailure` fails the
    // execution terminally with `type` = the declared error name and
    // `details[0]` = the schema-validated data — which the typed client
    // rehydrates back into a `ContractError`.
    let result: unknown;
    try {
      result = await implementation(context, validatedInput);
    } catch (error) {
      if (error instanceof ContractError) {
        // oxlint-disable-next-line unthrown/no-throw -- sanctioned ApplicationFailure model: a declared contract error fails the execution terminally with its typed wire shape (CLAUDE.md rule 2 exception)
        throw await contractErrorToApplicationFailure(
          error,
          definition.errors,
          `workflow "${workflowName}"`,
        );
      }
      // oxlint-disable-next-line unthrown/no-throw -- workflow-sandbox rethrow: an unmodeled implementation throw must reach Temporal untouched
      throw error;
    }

    // Validate workflow output, but hand Temporal the implementation's
    // ORIGINAL return value. This is the SENDING side of the result
    // boundary: the consuming side (client `result()`/`executeWorkflow`,
    // parent workflows awaiting a child) parses the payload, so a
    // transforming output schema is applied exactly once, on receive.
    const outputResult = await definition.output["~standard"].validate(result);
    if (outputResult.issues) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new WorkflowOutputValidationError(workflowName, outputResult.issues);
    }

    return result as WorkerInferOutput<TContract["workflows"][TWorkflowName]>;
  };

  // Temporal's client.workflow.start(fn, ...) reads `fn.name` to derive the
  // workflow type; without this the anonymous arrow above would surface as "".
  Object.defineProperty(workflowFn, "name", { value: workflowName, configurable: true });

  // Non-enumerable brand carrying the declared workflowName, so
  // `TypedWorker.create`'s registration check can identify
  // declareWorkflow-produced exports (and their intended registration name)
  // when it imports the workflows module. Non-enumerable keeps it invisible
  // to spreads / Object.keys; `Symbol.for` keeps it recognizable across
  // duplicated module instances.
  Object.defineProperty(workflowFn, DECLARED_WORKFLOW_BRAND, {
    value: workflowName,
    enumerable: false,
    configurable: true,
  });

  return workflowFn;
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
export type DeclareWorkflowOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
> = {
  workflowName: TWorkflowName;
  contract: TContract;
  implementation: WorkflowImplementation<TContract, TWorkflowName>;
  /**
   * Default activity options applied to every activity reachable from this
   * workflow (workflow-local + global) unless overridden. Merge precedence
   * per activity (least → most specific): this workflow-wide default → the
   * activity's contract-level `defineActivity({ activityOptions })` → the
   * explicit {@link activityOptionsByName} entry. See Temporal's
   * `ActivityOptions` for the full set of fields:
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
   *
   * Optional in isolation, but every activity reachable from this workflow
   * (workflow-local + global) must end up with a **bounded** merged result:
   * a per-attempt bound (`startToCloseTimeout` or `scheduleToCloseTimeout`)
   * AND a total bound (`scheduleToCloseTimeout`, or a finite positive
   * `retry.maximumAttempts`) — otherwise a failing activity retries forever.
   * This is checked unconditionally on the MERGE of all three layers
   * (`activityOptions` → the activity's contract-level `defineActivity({
   * activityOptions })` → {@link activityOptionsByName}), not on any single
   * layer in isolation: since each layer shallow-merges over the previous —
   * replacing a `retry` block wholesale, not field-by-field — two
   * individually-bounded layers can still merge to something unbounded.
   * Supplying `activityOptions` here does not exempt an activity that
   * carries its own contract-level or per-name options; if the FINAL merged
   * result for any reachable activity is missing either bound,
   * `declareWorkflow` throws `ContractMisuseError` at declaration time
   * (workflow-bundle load), naming every offending activity and which
   * bound(s) it lacks.
   */
  activityOptions?: ActivityOptions;
  /**
   * Per-activity `ActivityOptions` overrides. Each entry shallow-merges over
   * {@link activityOptions} for that activity only — the override wins on
   * every property it specifies, replacing the default value (including the
   * entire nested `retry` block when present, matching Temporal's
   * single-options-per-`proxyActivities`-call semantics).
   *
   * The override value is Temporal's full `ActivityOptions`, so any field is
   * fair game — including `taskQueue`, which lets you route individual
   * activities to dedicated worker pools (e.g. concurrency-capped queues for
   * LLM calls) while the rest of the workflow's activities stay on the default
   * queue. This keeps the Zod-validated typed-activities boundary intact, where
   * a raw `proxyActivities({ taskQueue })` would forfeit it.
   *
   * Activity names are typed against the contract; typos surface as TypeScript
   * errors rather than running silently with the default options.
   *
   * @example Tune timeouts and retries per activity
   * ```ts
   * // default — both bounds live here; `fastValidation` below only
   * // overrides `startToCloseTimeout`, so it still inherits this `retry`.
   * activityOptions: { startToCloseTimeout: '1 minute', retry: { maximumAttempts: 3 } },
   * activityOptionsByName: {
   *   chargePayment: {
   *     startToCloseTimeout: '5 minutes',
   *     retry: { maximumAttempts: 5 },
   *   },
   *   fastValidation: { startToCloseTimeout: '5 seconds' },
   * },
   * ```
   *
   * @example Route specific activities to a dedicated task queue
   * ```ts
   * // default — both bounds live here; the `taskQueue`-only override below
   * // still inherits this `retry`.
   * activityOptions: { startToCloseTimeout: '10 minutes', retry: { maximumAttempts: 3 } }, // default queue
   * activityOptionsByName: {
   *   // LLM call → dedicated, concurrency-capped queue.
   *   extractLayoutChunk: { taskQueue: 'gemini-pro' },
   *   // finalizeLayout, extractImages, … fall through to the default queue.
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
export type WorkflowImplementation<
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
/**
 * Typed error constructors for a workflow's declared `errors` map, or an
 * empty object when the workflow declares none.
 */
type WorkflowErrorConstructorsOf<TWorkflow> = TWorkflow extends {
  errors: infer TErrors extends Record<string, ErrorDefinition>;
}
  ? ContractErrorConstructors<TErrors>
  : Record<string, never>;

export type WorkflowContext<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
> = {
  activities: Readonly<WorkflowInferWorkflowContextActivities<TContract, TWorkflowName>>;
  info: WorkflowInfo;

  /**
   * Typed constructors for the errors declared on this workflow's contract
   * entry (`defineWorkflow({ errors: {...} })`). Throwing one fails the
   * execution with a typed, schema-validated failure the client rehydrates
   * into a `ContractError`:
   *
   * @example
   * ```ts
   * implementation: async (context, args) => {
   *   if (!args.items.length) {
   *     throw context.errors.EmptyOrder({ orderId: args.orderId });
   *   }
   *   // ...
   * }
   * ```
   */
  errors: WorkflowErrorConstructorsOf<TContract["workflows"][TWorkflowName]>;

  /**
   * Bind a signal handler within the workflow implementation (`handle*` —
   * the in-workflow binding tier of the verb convention). Allows the signal
   * handler to access workflow state.
   *
   * @example
   * ```ts
   * implementation: async (context, args) => {
   *   let currentValue = args.initialValue;
   *
   *   context.handleSignal('increment', async (signalArgs) => {
   *     currentValue += signalArgs.amount;
   *   });
   *
   *   // ... rest of workflow
   * }
   * ```
   */
  handleSignal: <K extends InferSignalNames<TContract["workflows"][TWorkflowName]>>(
    signalName: K,
    handler: SignalHandlerImplementation<SignalDefOf<TContract["workflows"][TWorkflowName], K>>,
  ) => void;

  /**
   * Bind a query handler within the workflow implementation (`handle*` —
   * the in-workflow binding tier of the verb convention). Allows the query
   * handler to access workflow state.
   *
   * Both query schemas (input and output) must validate synchronously —
   * Temporal runs query handlers synchronously. An async-validating schema
   * (e.g. zod async refine) trips a `ContractMisuseError` at bind time.
   *
   * @example
   * ```ts
   * implementation: async (context, args) => {
   *   let currentValue = args.initialValue;
   *
   *   context.handleQuery('getCurrentValue', () => {
   *     return { value: currentValue };
   *   });
   *
   *   // ... rest of workflow
   * }
   * ```
   */
  handleQuery: <K extends InferQueryNames<TContract["workflows"][TWorkflowName]>>(
    queryName: K,
    handler: QueryHandlerImplementation<QueryDefOf<TContract["workflows"][TWorkflowName], K>>,
  ) => void;

  /**
   * Bind an update handler within the workflow implementation (`handle*` —
   * the in-workflow binding tier of the verb convention). Allows the update
   * handler to access and modify workflow state.
   *
   * The update's *input* schema must validate synchronously — it feeds
   * Temporal's synchronous update validator slot. An async-validating schema
   * trips a `ContractMisuseError` at bind time (the output schema may be
   * async; it runs inside the handler body).
   *
   * @example
   * ```ts
   * implementation: async (context, args) => {
   *   let currentValue = args.initialValue;
   *
   *   context.handleUpdate('multiply', async (updateArgs) => {
   *     currentValue *= updateArgs.factor;
   *     return { newValue: currentValue };
   *   });
   *
   *   // ... rest of workflow
   * }
   * ```
   */
  handleUpdate: <K extends InferUpdateNames<TContract["workflows"][TWorkflowName]>>(
    updateName: K,
    handler: UpdateHandlerImplementation<UpdateDefOf<TContract["workflows"][TWorkflowName], K>>,
  ) => void;

  /**
   * Start a child workflow and return a typed handle with AsyncResult pattern
   *
   * The `contract` argument is always required — it identifies the task
   * queue and workflow definition the child runs against, and supplies the
   * `workflowIdReusePolicy` from the target workflow's declared `idempotency`
   * mode:
   * - Same-contract child: pass this worker's own contract and one of its
   *   workflow names.
   * - Cross-contract child: pass another worker's contract to invoke a
   *   workflow it serves (the child's task queue comes from that contract).
   *
   * An explicit `workflowIdReusePolicy` in `options` overrides the
   * contract's mode for this call only.
   *
   * @example
   * ```ts
   * import { P } from "unthrown";
   *
   * // Same contract child workflow
   * const childResult = await context.startChildWorkflow(myContract, 'processPayment', {
   *   workflowId: 'payment-123',
   *   args: { amount: 100 },
   *   parentClosePolicy: 'TERMINATE'
   * });
   *
   * // Cross-contract child workflow (from another worker)
   * const otherResult = await context.startChildWorkflow(otherContract, 'sendNotification', {
   *   workflowId: 'notification-123',
   *   args: { message: 'Hello' },
   *   parentClosePolicy: 'TERMINATE'
   * });
   *
   * await childResult.match({
   *   ok: async (handle) => {
   *     const result = await handle.result();
   *     // ... handle result
   *   },
   *   errCases: (matcher) =>
   *     matcher.with(
   *       P.tag('@temporal-contract/ChildWorkflowError'),
   *       P.tag('@temporal-contract/ChildWorkflowCancelledError'),
   *       P.tag('@temporal-contract/ChildWorkflowNotFoundError'),
   *       (error) => console.error('Failed to start:', error),
   *     ),
   *   defect: (cause) => console.error('Unexpected failure:', cause),
   * });
   * ```
   */
  startChildWorkflow: <
    TChildContract extends ContractDefinition,
    TChildWorkflowName extends keyof TChildContract["workflows"] & string,
  >(
    contract: TChildContract,
    workflowName: TChildWorkflowName,
    options: TypedChildWorkflowOptions<TChildContract, TChildWorkflowName>,
  ) => AsyncResult<
    TypedChildWorkflowHandle<TChildContract["workflows"][TChildWorkflowName]>,
    ChildWorkflowError | ChildWorkflowCancelledError | ChildWorkflowNotFoundError
  >;

  /**
   * Execute a child workflow (start and wait for result) with AsyncResult pattern
   *
   * The `contract` argument is always required — it identifies the task
   * queue and workflow definition the child runs against, and supplies the
   * `workflowIdReusePolicy` from the target workflow's declared `idempotency`
   * mode:
   * - Same-contract child: pass this worker's own contract and one of its
   *   workflow names.
   * - Cross-contract child: pass another worker's contract to invoke a
   *   workflow it serves (the child's task queue comes from that contract).
   *
   * An explicit `workflowIdReusePolicy` in `options` overrides the
   * contract's mode for this call only.
   *
   * @example
   * ```ts
   * import { P } from "unthrown";
   *
   * // Same contract child workflow
   * const result = await context.executeChildWorkflow(myContract, 'processPayment', {
   *   workflowId: 'payment-123',
   *   args: { amount: 100 },
   *   parentClosePolicy: 'TERMINATE'
   * });
   *
   * // Cross-contract child workflow (from another worker)
   * const otherResult = await context.executeChildWorkflow(otherContract, 'sendNotification', {
   *   workflowId: 'notification-123',
   *   args: { message: 'Hello' },
   *   parentClosePolicy: 'TERMINATE'
   * });
   *
   * await result.match({
   *   ok: (output) => console.log('Payment processed:', output),
   *   errCases: (matcher) =>
   *     matcher.with(
   *       P.tag('@temporal-contract/ChildWorkflowError'),
   *       P.tag('@temporal-contract/ChildWorkflowCancelledError'),
   *       P.tag('@temporal-contract/ChildWorkflowNotFoundError'),
   *       (error) => console.error('Processing failed:', error),
   *     ),
   *   defect: (cause) => console.error('Unexpected failure:', cause),
   * });
   * ```
   */
  executeChildWorkflow: <
    TChildContract extends ContractDefinition,
    TChildWorkflowName extends keyof TChildContract["workflows"] & string,
  >(
    contract: TChildContract,
    workflowName: TChildWorkflowName,
    options: TypedChildWorkflowOptions<TChildContract, TChildWorkflowName>,
  ) => AsyncResult<
    ClientInferOutput<TChildContract["workflows"][TChildWorkflowName]>,
    ChildWorkflowError | ChildWorkflowCancelledError | ChildWorkflowNotFoundError
  >;

  /**
   * Run `fn` inside a cancellable Temporal scope. If the workflow (or an
   * ancestor scope) is cancelled while `fn` is in flight, the resulting
   * AsyncResult resolves to `Err(WorkflowCancelledError)` instead of
   * rejecting — letting callers handle cancellation explicitly, typically
   * to perform a graceful exit from the current step.
   *
   * Non-cancellation errors thrown by `fn` are *unmodeled* failures: they ride
   * unthrown's `defect` channel (inspectable via `result.isDefect()` /
   * `result.cause`, re-thrown at the edge), keeping the modeled error channel
   * to the single anticipated outcome — cancellation.
   *
   * @example
   * ```ts
   *
   * implementation: async (context, args) => {
   *   const result = await context.cancellableScope(async () => {
   *     // `fn`'s return value becomes the scope's `T` verbatim, so await and
   *     // narrow the activity's own AsyncResult HERE, inside the callback.
   *     // `AsyncResult` is deliberately not a full `PromiseLike` (no
   *     // `.catch`/`.finally`), so returning an un-awaited activity call
   *     // would make `T` the un-awaited `AsyncResult` itself — which has no
   *     // `isOk`/`isErr`/`.value` (only the plain `Result` you get by
   *     // awaiting does).
   *     const step = await context.activities.processStep(args);
   *     if (step.isDefect()) {
   *       throw step.cause; // an unmodeled bug — surfaces as the scope's own defect
   *     }
   *     return step.isOk() ? { status: "ok" as const } : { status: "failed" as const };
   *   });
   *
   *   if (result.isDefect()) {
   *     throw result.cause; // a genuine bug thrown inside the scope, not a cancel
   *   }
   *   if (result.isErr()) {
   *     // The scope itself was cancelled — perform cleanup that must not be
   *     // cancelled. Capture nonCancellableScope's OWN AsyncResult too — a
   *     // bare `await` here would silently discard a defect thrown inside
   *     // the cleanup callback.
   *     const released = await context.nonCancellableScope(async () => {
   *       const step = await context.activities.releaseResources(args);
   *       if (step.isErr()) {
   *         // best-effort cleanup — log and continue regardless
   *       }
   *     });
   *     if (released.isDefect()) {
   *       throw released.cause; // a genuine bug in cleanup, not a cancel
   *     }
   *     return { status: "cancelled" };
   *   }
   *
   *   return result.value;
   * }
   * ```
   */
  cancellableScope: <T>(fn: () => T | Promise<T>) => AsyncResult<T, WorkflowCancelledError>;

  /**
   * Run `fn` inside a non-cancellable Temporal scope. Cancellation requests
   * from outside the scope are ignored for its duration — the idiomatic way
   * to perform cleanup work that must not be interrupted.
   *
   * Returns the same `AsyncResult<...>` shape as
   * {@link WorkflowContext.cancellableScope} for symmetry; the
   * `Err(WorkflowCancelledError)` branch only triggers when cancellation is
   * raised from *inside* the scope, which is rare. Non-cancellation errors
   * surface on the `defect` channel.
   */
  nonCancellableScope: <T>(fn: () => T | Promise<T>) => AsyncResult<T, WorkflowCancelledError>;

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
