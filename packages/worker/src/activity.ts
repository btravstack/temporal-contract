// Entry point for activity implementations.
//
// Activities run *outside* the workflow sandbox, so they use unthrown's
// `AsyncResult` directly. Workflow code (see workflow.ts) uses the same
// unthrown API — unthrown's evaluation is compatible with Temporal's
// deterministic replay machinery.
//
// Errors flow through Temporal's `ApplicationFailure` (re-exported from
// `@temporalio/common`) — it's the SDK's first-class failure shape, so we
// don't wrap it in a custom class. `ApplicationFailure` exposes
// `nonRetryable`, `type`, `details`, and `category` natively, and survives
// the activity → workflow serialization boundary unchanged.
//
// Contract-declared typed errors (`defineActivity({ errors: {...} })`) ride
// the same rails: implementations build them with the typed constructors in
// the helpers argument, and the wrapper converts them to `ApplicationFailure`
// (`type` = error name, `details[0]` = validated data, `nonRetryable` from
// the contract) at the boundary.
import {
  type ActivityDefinition,
  type ContractDefinition,
  type ErrorDefinition,
} from "@temporal-contract/contract";
import {
  _internal_buildErrorConstructors,
  ContractError,
  type AnyContractError,
  type ContractErrorConstructors,
  type ContractErrorInputUnion,
} from "@temporal-contract/contract/errors";
import { ApplicationFailure } from "@temporalio/common";
import { P, tag, type AsyncResult } from "unthrown";

import { contractErrorToApplicationFailure } from "./contract-errors.js";
import {
  ActivityDefinitionNotFoundError,
  ActivityInputValidationError,
  ActivityOutputValidationError,
} from "./errors.js";
import { extractHandlerInput, makeAsyncResult } from "./internal.js";
import { type WorkerInferInput, type WorkerInferOutput } from "./types.js";

export {
  ActivityDefinitionNotFoundError,
  ActivityInputValidationError,
  ActivityOutputValidationError,
  ContractErrorDataValidationError,
  ValidationError,
} from "./errors.js";

// Re-export the canonical activity-failure class so consumers don't need
// a separate `@temporalio/common` import to construct one.
export { ApplicationFailure } from "@temporalio/common";

// Re-export the typed contract-error surface so implementations can
// `instanceof`-check and type against it without a separate
// `@temporal-contract/contract/errors` import.
export {
  ContractError,
  type AnyContractError,
  type ContractErrorConstructors,
  type ContractErrorOptions,
} from "@temporal-contract/contract/errors";

/**
 * Build a qualifier for `fromPromise` that wraps a rejection in an
 * {@link ApplicationFailure} of the given `type`.
 *
 * Replaces the hand-written wrapping every activity otherwise repeats:
 * an `Error` rejection keeps its own message and is preserved as `cause`
 * (so stack traces survive the activity → workflow boundary); anything
 * else falls back to `options.message` (or `String(error)`).
 *
 * @example
 * ```ts
 * import { declareActivitiesHandler, qualify } from '@temporal-contract/worker/activity';
 * import { fromPromise } from 'unthrown';
 *
 * export const activities = declareActivitiesHandler({
 *   contract: myContract,
 *   activities: {
 *     sendEmail: (args) =>
 *       fromPromise(emailService.send(args), qualify('EMAIL_SEND_FAILED'))
 *         .map(() => ({ sent: true })),
 *     chargeCard: (args) =>
 *       fromPromise(
 *         paymentGateway.charge(args),
 *         // Permanent failure: opt out of the configured retry policy.
 *         qualify('CARD_DECLINED', { nonRetryable: true }),
 *       ),
 *   },
 * });
 * ```
 *
 * @remarks
 * The qualifier **always** wraps — even when the rejection is already an
 * `ApplicationFailure` — so the resulting failure's `type` is guaranteed
 * to be the declared one (retry policies keyed on
 * `retry.nonRetryableErrorTypes` can rely on it). The original failure is
 * preserved as `cause`. Note the flip side: because the wrapper's `type` and
 * `nonRetryable` take precedence, an inner `ApplicationFailure`'s own
 * `type`/`nonRetryable: true` is masked — pass `{ nonRetryable: true }` here (or
 * write a custom qualifier) if that inner failure should stay non-retryable.
 */
export function qualify(
  type: string,
  options?: {
    /** Fallback message when the rejection is not an `Error` (default: `String(error)`). */
    message?: string;
    /** Mark the failure non-retryable — Temporal stops retrying immediately. */
    nonRetryable?: boolean;
    /** Structured payload forwarded to the workflow (avoids parsing `message`). */
    details?: unknown[];
  },
): (error: unknown) => ApplicationFailure {
  return (error) =>
    ApplicationFailure.create({
      type,
      message: error instanceof Error ? error.message : (options?.message ?? String(error)),
      ...(error instanceof Error ? { cause: error } : {}),
      ...(options?.nonRetryable !== undefined ? { nonRetryable: options.nonRetryable } : {}),
      ...(options?.details !== undefined ? { details: options.details } : {}),
    });
}

/**
 * Typed error constructors for an activity's declared `errors` map, or an
 * empty object when the activity declares none.
 */
type ActivityErrorConstructorsOf<TActivity extends ActivityDefinition> = TActivity extends {
  errors: infer TErrors extends Record<string, ErrorDefinition>;
}
  ? ContractErrorConstructors<TErrors>
  : Record<string, never>;

/**
 * Error channel of an activity implementation: always `ApplicationFailure`
 * (technical failures), plus the activity's declared contract errors when
 * it has any.
 */
type ActivityImplementationErrorOf<TActivity extends ActivityDefinition> = TActivity extends {
  errors: infer TErrors extends Record<string, ErrorDefinition>;
}
  ? ApplicationFailure | ContractErrorInputUnion<TErrors>
  : ApplicationFailure;

/**
 * Second argument passed to every activity implementation.
 *
 * - `errors` — typed constructors for the errors declared on this activity's
 *   contract entry. `Err(errors.PaymentDeclined({ reason }))` surfaces to the
 *   calling workflow as a typed, schema-validated error.
 * - `context` — the accumulated typed context: the `createContext` seed
 *   plus everything injected by the middleware chain via
 *   `next({ context })` (an empty object when neither is configured). Use
 *   it to inject dependencies (service clients, repositories) instead of
 *   closing over them at module scope.
 */
export type ActivityImplementationHelpers<
  TActivity extends ActivityDefinition,
  TContext extends Record<string, unknown> | EmptyContext = EmptyContext,
> = {
  readonly errors: ActivityErrorConstructorsOf<TActivity>;
  readonly context: TContext;
};

/**
 * Activity implementation using unthrown's `AsyncResult`.
 *
 * Returns `AsyncResult<Output, ApplicationFailure | declared errors>` for
 * explicit error handling instead of throwing. The wrapper rethrows `Err()`
 * payloads at the activity boundary (converting contract errors to
 * `ApplicationFailure` first); Temporal recognizes `ApplicationFailure`
 * natively and applies the configured retry policy (with
 * `nonRetryable: true` opting an instance out per-call). An unexpected
 * throw surfaces as a `defect` and is re-thrown with its original cause.
 *
 * The helpers argument is optional to consume — implementations that need
 * neither typed errors nor injected context keep the plain `(args) => ...`
 * shape.
 */
type ResultActivityImplementation<
  TActivity extends ActivityDefinition,
  TContext extends Record<string, unknown> | EmptyContext = EmptyContext,
> = (
  args: WorkerInferInput<TActivity>,
  helpers: ActivityImplementationHelpers<TActivity, TContext>,
) => AsyncResult<WorkerInferOutput<TActivity>, ActivityImplementationErrorOf<TActivity>>;

/**
 * Map of all activity implementations for a contract (global + all workflow-specific).
 *
 * **Shape note — input is nested by workflow, output is flat.** This
 * asymmetry is deliberate:
 *
 * - The implementation map you write **mirrors the contract's structure**:
 *   global activities sit at the root, workflow-local activities nest
 *   under their owning workflow's name. Mirroring the contract gives
 *   IDE autocomplete that matches `defineContract`, prevents typos that
 *   put a workflow-local activity at the global level, and makes
 *   ownership visible at definition time.
 * - The handler returned by {@link declareActivitiesHandler} (see
 *   {@link ActivitiesHandler}) is **flat** because Temporal's worker
 *   sees a single activity namespace at runtime —
 *   `proxyActivities<...>()` resolves names from one map regardless of
 *   which workflow consumes them. `defineContract` enforces no name
 *   collisions across global + workflow-local scopes, so the flat
 *   output has no ambiguity to resolve.
 *
 * In short: write nested (mirror the contract); the wrapper flattens
 * for Temporal.
 */
type ContractResultActivitiesImplementations<
  TContract extends ContractDefinition,
  TContext extends Record<string, unknown> | EmptyContext = EmptyContext,
> =
  // Global activities
  (TContract["activities"] extends Record<string, ActivityDefinition>
    ? ResultActivitiesImplementations<TContract["activities"], TContext>
    : {}) &
    // All workflow-specific activities merged
    {
      [TWorkflow in keyof TContract["workflows"]]: TContract["workflows"][TWorkflow]["activities"] extends Record<
        string,
        ActivityDefinition
      >
        ? ResultActivitiesImplementations<TContract["workflows"][TWorkflow]["activities"], TContext>
        : {};
    };

type ResultActivitiesImplementations<
  TActivities extends Record<string, ActivityDefinition>,
  TContext extends Record<string, unknown> | EmptyContext = EmptyContext,
> = {
  [K in keyof TActivities]: ResultActivityImplementation<TActivities[K], TContext>;
};

/**
 * Per-invocation description handed to middleware and `createContext`.
 */
export type ActivityInvocationInfo = {
  /** Flat runtime name of the activity (as Temporal sees it). */
  readonly activityName: string;
  /** Owning workflow for workflow-local activities; `undefined` for global ones. */
  readonly workflowName: string | undefined;
};

/**
 * The empty middleware context. `Record<never, never>` rather than `{}` so
 * an empty context is a real "no properties" type instead of the
 * anything-goes empty-object type. (Mirrors amqp-contract's `EmptyContext`.)
 */
export type EmptyContext = Record<never, never>;

/**
 * Continuation invoked by an {@link ActivityMiddleware}.
 *
 * - `next()` — forward unchanged.
 * - `next({ context: { ... } })` — extend the typed context flowing
 *   downstream; the patch is shallow-merged over the current context, so
 *   later middleware and the implementation see the accumulated value.
 * - `next({ input: ... })` — substitute the input. A substituted input is
 *   re-validated against the activity's input schema before it flows
 *   downstream — an invalid substitution fails terminally with
 *   `ActivityInputValidationError`, so middleware cannot smuggle
 *   unvalidated data past the contract boundary.
 */
export type ActivityMiddlewareNext<
  TContextOut extends Record<string, unknown> | EmptyContext = EmptyContext,
> = (opts?: {
  readonly input?: unknown;
  readonly context?: TContextOut;
}) => AsyncResult<unknown, ApplicationFailure | AnyContractError>;

/**
 * Contract-aware middleware wrapped around every activity implementation.
 *
 * Middleware runs *inside* the validation boundary — `invocation.input` is
 * already validated against the contract's input schema, and whatever the
 * chain returns on the `ok` channel is still validated against the output
 * schema afterwards. Because it operates on the unthrown `AsyncResult`
 * rather than thrown exceptions, a middleware observes modeled failures
 * (`ApplicationFailure`, contract errors) on the `err` channel and can
 * short-circuit by returning its own result without calling `next`.
 *
 * Context accumulates through the chain: `TContextIn` is what this
 * middleware receives (the `createContext` seed for the outermost one),
 * `TContextOut extends TContextIn` is what it passes downstream via
 * `next({ context })`. A middleware that only reads context leaves both
 * parameters equal and stays valid unchanged. Compose typed chains with
 * {@link composeActivityMiddleware}; pin a middleware's context types
 * without a variable annotation via {@link defineActivityMiddleware}.
 *
 * @example Log every activity invocation and its outcome (read-only)
 * ```ts
 * const logging: ActivityMiddleware = ({ activityName, workflowName }, next) =>
 *   next().tapErrCases((matcher) =>
 *     matcher.with(
 *       P.instanceOf(ApplicationFailure),
 *       tag("@temporal-contract/ContractError"),
 *       (error) => {
 *         logger.warn({ activityName, workflowName, error }, "activity failed");
 *       },
 *     ),
 *   );
 * ```
 *
 * @example Guard-and-narrow: inject a tenant id for everything downstream
 * ```ts
 * const auth = defineActivityMiddleware<EmptyContext, { tenantId: string }>(
 *   (invocation, next) => {
 *     const tenantId = readTenant(invocation.input);
 *     if (!tenantId) {
 *       return Err(ApplicationFailure.create({ type: "Unauthenticated", nonRetryable: true })).toAsync();
 *     }
 *     return next({ context: { tenantId } });
 *   },
 * );
 * ```
 */
export type ActivityMiddleware<
  TContextIn extends Record<string, unknown> | EmptyContext = EmptyContext,
  TContextOut extends TContextIn = TContextIn,
> = (
  invocation: ActivityInvocationInfo & {
    /** Schema-validated input for this invocation. */
    readonly input: unknown;
    /** Context accumulated so far (the `createContext` seed for the outermost middleware). */
    readonly context: TContextIn;
  },
  next: ActivityMiddlewareNext<TContextOut>,
) => AsyncResult<unknown, ApplicationFailure | AnyContractError>;

/**
 * Context-erased middleware shape used by the runtime chain.
 */
export type AnyActivityMiddleware = ActivityMiddleware<
  Record<string, unknown>,
  Record<string, unknown>
>;

/**
 * Identity helper that pins a middleware's context types without a variable
 * annotation. (Mirrors amqp-contract's `defineMiddleware`.)
 */
export function defineActivityMiddleware<
  TContextIn extends Record<string, unknown> | EmptyContext = EmptyContext,
  TContextOut extends TContextIn = TContextIn,
>(
  middleware: ActivityMiddleware<TContextIn, TContextOut>,
): ActivityMiddleware<TContextIn, TContextOut> {
  return middleware;
}

/**
 * Compose middleware outermost-first into a single {@link ActivityMiddleware}
 * whose context type accumulates across the chain — each middleware's
 * `TContextOut` bounds the next one's `TContextIn`, so the composed result's
 * out-context is the last middleware's. For chains longer than eight, nest:
 * a composed chain is itself an `ActivityMiddleware` and can be the *first*
 * argument of an outer `composeActivityMiddleware` call.
 *
 * (Mirrors amqp-contract's `composeMiddleware` overload approach.)
 */
export function composeActivityMiddleware<
  TSeed extends Record<string, unknown> | EmptyContext,
  TA extends TSeed,
>(m1: ActivityMiddleware<TSeed, TA>): ActivityMiddleware<TSeed, TA>;
export function composeActivityMiddleware<
  TSeed extends Record<string, unknown> | EmptyContext,
  TA extends TSeed,
  TB extends TA,
>(m1: ActivityMiddleware<TSeed, TA>, m2: ActivityMiddleware<TA, TB>): ActivityMiddleware<TSeed, TB>;
export function composeActivityMiddleware<
  TSeed extends Record<string, unknown> | EmptyContext,
  TA extends TSeed,
  TB extends TA,
  TC extends TB,
>(
  m1: ActivityMiddleware<TSeed, TA>,
  m2: ActivityMiddleware<TA, TB>,
  m3: ActivityMiddleware<TB, TC>,
): ActivityMiddleware<TSeed, TC>;
export function composeActivityMiddleware<
  TSeed extends Record<string, unknown> | EmptyContext,
  TA extends TSeed,
  TB extends TA,
  TC extends TB,
  TD extends TC,
>(
  m1: ActivityMiddleware<TSeed, TA>,
  m2: ActivityMiddleware<TA, TB>,
  m3: ActivityMiddleware<TB, TC>,
  m4: ActivityMiddleware<TC, TD>,
): ActivityMiddleware<TSeed, TD>;
export function composeActivityMiddleware<
  TSeed extends Record<string, unknown> | EmptyContext,
  TA extends TSeed,
  TB extends TA,
  TC extends TB,
  TD extends TC,
  TE extends TD,
>(
  m1: ActivityMiddleware<TSeed, TA>,
  m2: ActivityMiddleware<TA, TB>,
  m3: ActivityMiddleware<TB, TC>,
  m4: ActivityMiddleware<TC, TD>,
  m5: ActivityMiddleware<TD, TE>,
): ActivityMiddleware<TSeed, TE>;
export function composeActivityMiddleware<
  TSeed extends Record<string, unknown> | EmptyContext,
  TA extends TSeed,
  TB extends TA,
  TC extends TB,
  TD extends TC,
  TE extends TD,
  TF extends TE,
>(
  m1: ActivityMiddleware<TSeed, TA>,
  m2: ActivityMiddleware<TA, TB>,
  m3: ActivityMiddleware<TB, TC>,
  m4: ActivityMiddleware<TC, TD>,
  m5: ActivityMiddleware<TD, TE>,
  m6: ActivityMiddleware<TE, TF>,
): ActivityMiddleware<TSeed, TF>;
export function composeActivityMiddleware<
  TSeed extends Record<string, unknown> | EmptyContext,
  TA extends TSeed,
  TB extends TA,
  TC extends TB,
  TD extends TC,
  TE extends TD,
  TF extends TE,
  TG extends TF,
>(
  m1: ActivityMiddleware<TSeed, TA>,
  m2: ActivityMiddleware<TA, TB>,
  m3: ActivityMiddleware<TB, TC>,
  m4: ActivityMiddleware<TC, TD>,
  m5: ActivityMiddleware<TD, TE>,
  m6: ActivityMiddleware<TE, TF>,
  m7: ActivityMiddleware<TF, TG>,
): ActivityMiddleware<TSeed, TG>;
export function composeActivityMiddleware<
  TSeed extends Record<string, unknown> | EmptyContext,
  TA extends TSeed,
  TB extends TA,
  TC extends TB,
  TD extends TC,
  TE extends TD,
  TF extends TE,
  TG extends TF,
  TH extends TG,
>(
  m1: ActivityMiddleware<TSeed, TA>,
  m2: ActivityMiddleware<TA, TB>,
  m3: ActivityMiddleware<TB, TC>,
  m4: ActivityMiddleware<TC, TD>,
  m5: ActivityMiddleware<TD, TE>,
  m6: ActivityMiddleware<TE, TF>,
  m7: ActivityMiddleware<TF, TG>,
  m8: ActivityMiddleware<TG, TH>,
): ActivityMiddleware<TSeed, TH>;
export function composeActivityMiddleware(
  ...middlewares: readonly AnyActivityMiddleware[]
): AnyActivityMiddleware {
  return (invocation, next) => {
    const run = (
      index: number,
      input: unknown,
      inputPatched: boolean,
      context: Record<string, unknown>,
    ): ReturnType<AnyActivityMiddleware> =>
      index >= middlewares.length
        ? // Only surface `input` in the terminal patch when some stage
          // actually substituted it — an untouched input must not trigger
          // the wrapper's re-validation pass.
          next(inputPatched ? { input, context } : { context })
        : middlewares[index]!({ ...invocation, input, context }, (opts) =>
            run(
              index + 1,
              opts && "input" in opts ? opts.input : input,
              inputPatched || (opts !== undefined && "input" in opts),
              { ...context, ...opts?.context },
            ),
          );
    return run(0, invocation.input, false, invocation.context);
  };
}

/**
 * Options for creating activities handler
 */
type DeclareActivitiesHandlerOptions<
  TContract extends ContractDefinition,
  TContext extends Record<string, unknown> | EmptyContext = EmptyContext,
  TInjected extends TContext = TContext,
> = {
  contract: TContract;
  activities: ContractResultActivitiesImplementations<TContract, TInjected>;
  /**
   * Build the typed dependency context *seed* handed to the middleware
   * chain and, accumulated, to every implementation as `helpers.context`.
   * Invoked once per activity execution, so it can produce request-scoped
   * values; close over singletons (DB pools, service clients) for
   * per-worker dependencies. Omitted → the seed is an empty object.
   *
   * For scoped, resource-releasing contexts (per-invocation loggers,
   * transactions), the recommended implementation is demesne's
   * `Layer.forkScope` — see the "Dependency Injection" section of the
   * activity-handlers guide.
   */
  createContext?: (info: ActivityInvocationInfo) => TContext | Promise<TContext>;
  /**
   * Contract-aware middleware wrapped around every activity implementation.
   * Pass a single middleware, or a typed chain built with
   * {@link composeActivityMiddleware} — the chain's final context type
   * (`TInjected`) is what implementations receive as `helpers.context`.
   * See {@link ActivityMiddleware}.
   */
  middleware?: ActivityMiddleware<TContext, TInjected>;
};

type ActivityImplementation<TActivity extends ActivityDefinition> = (
  args: WorkerInferInput<TActivity>,
) => Promise<WorkerInferOutput<TActivity>>;

type ActivitiesImplementations<TActivities extends Record<string, ActivityDefinition>> = {
  [K in keyof TActivities]: ActivityImplementation<TActivities[K]>;
};

type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

/**
 * Activities handler ready for Temporal's `Worker.create({ activities })`.
 *
 * Flat shape: every activity (global + all workflow-local) lives at the
 * root of the returned map. See the doc comment on
 * {@link ContractResultActivitiesImplementations} for why the input you
 * write is nested by workflow while this output is flat.
 */
export type ActivitiesHandler<TContract extends ContractDefinition> =
  // Global activities
  (TContract["activities"] extends Record<string, ActivityDefinition>
    ? ActivitiesImplementations<TContract["activities"]>
    : {}) &
    // All workflow-specific activities merged at root level (flat)
    UnionToIntersection<
      {
        [TWorkflow in keyof TContract["workflows"]]: TContract["workflows"][TWorkflow]["activities"] extends Record<
          string,
          ActivityDefinition
        >
          ? ActivitiesImplementations<TContract["workflows"][TWorkflow]["activities"]>
          : {};
      }[keyof TContract["workflows"]]
    >;

/**
 * Create a typed activities handler with automatic validation and Result pattern.
 *
 * This wraps all activity implementations with:
 * - Validation at network boundaries
 * - `AsyncResult<T, ApplicationFailure | declared errors>` pattern for
 *   explicit error handling
 * - Automatic conversion from Result to Promise (throwing on Error)
 * - Typed constructors for contract-declared errors and an optional
 *   dependency context (see {@link ActivityImplementationHelpers})
 * - An optional contract-aware middleware chain (see
 *   {@link ActivityMiddleware})
 *
 * TypeScript ensures ALL activities (global + workflow-specific) are implemented.
 *
 * Use this to create the activities object for the Temporal Worker.
 *
 * @example
 * ```ts
 * import { declareActivitiesHandler, ApplicationFailure } from '@temporal-contract/worker/activity';
 * import { fromPromise, Ok, Err } from 'unthrown';
 * import myContract from './contract.js';
 *
 * export const activities = declareActivitiesHandler({
 *   contract: myContract,
 *   // Typed dependency injection: implementations receive this via
 *   // `helpers.context` instead of closing over module state.
 *   createContext: () => ({ emailService }),
 *   activities: {
 *     // Activity returns AsyncResult instead of throwing.
 *     sendEmail: (args, { errors, context }) =>
 *       fromPromise(
 *         context.emailService.send(args),
 *         (error) =>
 *           // Wrap technical errors in ApplicationFailure. `nonRetryable`
 *           // is per-instance: set it to true on permanent failures so
 *           // Temporal stops retrying immediately.
 *           ApplicationFailure.create({
 *             type: 'EMAIL_SEND_FAILED',
 *             message: 'Failed to send email',
 *             nonRetryable: false,
 *             cause: error instanceof Error ? error : undefined,
 *           }),
 *       ).flatMap((outcome) =>
 *         outcome.accepted
 *           ? Ok({ sent: true })
 *           : // Contract-declared error: typed on the caller's side, with
 *             // `nonRetryable` taken from the contract declaration.
 *             Err(errors.RecipientRejected({ reason: outcome.reason })),
 *       ),
 *   },
 * });
 *
 * // Use with Temporal Worker
 * import { Worker } from '@temporalio/worker';
 * import { workflowsPathFromURL } from '@temporal-contract/worker/worker';
 *
 * const worker = await Worker.create({
 *   workflowsPath: workflowsPathFromURL(import.meta.url, './workflows.js'),
 *   activities: activities,
 *   taskQueue: contract.taskQueue,
 * });
 * ```
 *
 * @remarks
 * The wrapper accepts implementations in the
 * `AsyncResult<T, ApplicationFailure | declared errors>` shape and produces
 * ordinary Promise-returning Temporal handlers (`Err(ApplicationFailure)` →
 * thrown; `Err(ContractError)` → data validated against the declared schema
 * and thrown as an `ApplicationFailure` with `type` = error name,
 * `details[0]` = data, `nonRetryable` from the contract; `Ok(...)` → output
 * validated against the contract and resolved; `defect` → original cause
 * re-thrown). It does **not** hide Temporal's
 * `@temporalio/activity` runtime: inside the body you can still call
 * `Context.current()` from `@temporalio/activity` to access heartbeats
 * (`heartbeat(details)`, `heartbeatDetails`), activity info (attempt
 * number, workflow IDs), and the async-completion task token. See the
 * "Working with the Activity Context" section of the worker
 * implementation guide for end-to-end examples.
 */
export function declareActivitiesHandler<
  TContract extends ContractDefinition,
  TContext extends Record<string, unknown> | EmptyContext = EmptyContext,
  TInjected extends TContext = TContext,
>(
  options: DeclareActivitiesHandlerOptions<TContract, TContext, TInjected>,
): ActivitiesHandler<TContract> {
  const { contract, activities, createContext } = options;
  // Context types are erased at the dispatch boundary: implementations
  // receive whatever the (type-checked) middleware chain produced at runtime.
  const middleware = options.middleware as AnyActivityMiddleware | undefined;

  // Prepare Temporal-compatible activities with validation and Result unwrapping
  const wrappedActivities = {} as ActivitiesHandler<TContract>;

  // Helper to create a wrapped implementation from a definition and impl.
  // `label` is the diagnostic name used in validation errors (workflow-local
  // activities keep the historical `workflow.activity` format); `info` is the
  // runtime identity handed to middleware and `createContext`.
  function makeWrapped(
    label: string,
    info: ActivityInvocationInfo,
    activityDef: ActivityDefinition,
    activityImpl: (
      args: unknown,
      helpers: { errors: unknown; context: unknown },
    ) => AsyncResult<unknown, ApplicationFailure | AnyContractError>,
  ) {
    // Constructors are stateless and derived from contract-time immutables,
    // so build them once per activity at declaration time.
    const errorConstructors = _internal_buildErrorConstructors(activityDef.errors);

    return async (...args: unknown[]) => {
      const input = extractHandlerInput(args);

      // Validate input
      const inputResult = await activityDef.input["~standard"].validate(input);
      if (inputResult.issues) {
        throw new ActivityInputValidationError(label, inputResult.issues);
      }

      // The `createContext` seed; the middleware chain accumulates on top of
      // it via `next({ context })` patches, and the implementation sees the
      // final accumulated value.
      const seedContext: Record<string, unknown> = createContext
        ? ((await createContext(info)) as Record<string, unknown>)
        : {};

      const invokeImplementation = (
        stageInput: unknown,
        stageContext: Record<string, unknown>,
      ): AsyncResult<unknown, ApplicationFailure | AnyContractError> =>
        activityImpl(stageInput, { errors: errorConstructors, context: stageContext });

      // Run the (single, possibly composed) middleware around the
      // implementation. `next({ input })` substitutions are re-validated
      // against the contract's input schema so the validation boundary holds
      // regardless of what the middleware injects (an invalid substitution
      // is a deterministic bug and fails terminally, same as invalid caller
      // input); `next({ context })` patches shallow-merge over the current
      // context.
      const chain = (
        validatedInput: unknown,
      ): AsyncResult<unknown, ApplicationFailure | AnyContractError> => {
        if (!middleware) {
          return invokeImplementation(validatedInput, seedContext);
        }
        return middleware({ ...info, input: validatedInput, context: seedContext }, (opts) => {
          const nextContext = opts?.context ? { ...seedContext, ...opts.context } : seedContext;
          if (opts && "input" in opts) {
            const substituted = opts.input;
            return makeAsyncResult(async () => {
              const revalidated = await activityDef.input["~standard"].validate(substituted);
              if (revalidated.issues) {
                throw new ActivityInputValidationError(label, revalidated.issues);
              }
              return await invokeImplementation(revalidated.value, nextContext);
            });
          }
          return invokeImplementation(validatedInput, nextContext);
        });
      };

      // Execute unthrown activity (returns AsyncResult); awaiting yields a
      // Result.
      const result = await chain(inputResult.value);

      // Fold the three channels: validate output on `ok`, surface the modeled
      // error on `err` (converting a typed contract error to its
      // `ApplicationFailure` wire shape first), and re-throw a `defect`'s
      // original cause (an unexpected throw inside the activity is a bug,
      // not a domain error).
      return result.match({
        ok: async (value) => {
          const outputResult = await activityDef.output["~standard"].validate(value);
          if (outputResult.issues) {
            throw new ActivityOutputValidationError(label, outputResult.issues);
          }
          return outputResult.value;
        },
        // Convert Err(...) payload to thrown ApplicationFailure for Temporal.
        // Temporal recognizes this class natively and applies the configured
        // retry policy (honoring `nonRetryable: true`). Contract errors are
        // validated against their declared data schema and serialized as
        // ApplicationFailure(type = error name, details = [data]).
        errCases: (matcher) =>
          matcher.with(
            P.instanceOf(ApplicationFailure),
            tag("@temporal-contract/ContractError"),
            async (error) => {
              if (error instanceof ContractError) {
                throw await contractErrorToApplicationFailure(
                  error,
                  activityDef.errors,
                  `activity "${label}"`,
                );
              }
              throw error;
            },
          ),
        // A defect is an *unanticipated* throw inside the activity. Re-throw the
        // original cause unwrapped: Temporal wraps a non-`ApplicationFailure`
        // error as `ApplicationFailure(type: "Error")` and applies the default
        // (retryable) policy — preserving the pre-unthrown behaviour where an
        // uncaught activity throw was simply retried. We deliberately do NOT
        // coerce it to `nonRetryable`: not every unexpected throw is permanent
        // (a transient I/O fault is also "unmodeled"), and forcing fail-fast
        // here would silently change retry semantics. An activity that wants a
        // permanent failure should return `Err(ApplicationFailure.create({
        // nonRetryable: true }))` explicitly.
        defect: (cause) => {
          throw cause;
        },
      });
    };
  }

  // 1) Wrap global activities defined directly under contract.activities
  if (contract.activities) {
    for (const [activityName, impl] of Object.entries(activities)) {
      // Skip workflow namespaces if present at root
      if (contract.workflows && activityName in contract.workflows) {
        continue;
      }

      const activityDef = contract.activities[activityName];
      if (!activityDef) {
        throw new ActivityDefinitionNotFoundError(activityName, Object.keys(contract.activities));
      }

      // Assign wrapped global activity
      (wrappedActivities as Record<string, unknown>)[activityName] = makeWrapped(
        activityName,
        { activityName, workflowName: undefined },
        activityDef,
        impl as (
          args: unknown,
          helpers: { errors: unknown; context: unknown },
        ) => AsyncResult<unknown, ApplicationFailure | AnyContractError>,
      );
    }
  }

  // 2) Wrap workflow-scoped activities at root level (flat)
  if (contract.workflows) {
    for (const [workflowName, workflowDef] of Object.entries(contract.workflows)) {
      const wfActivitiesImpl = (activities as Record<string, unknown>)[workflowName] as
        | Record<string, unknown>
        | undefined;
      if (!wfActivitiesImpl) {
        // If no implementations provided for this workflow, skip (TypeScript typing should enforce completeness for declared ones)
        continue;
      }

      const wfDefs = workflowDef.activities ?? {};

      for (const [activityName, impl] of Object.entries(wfActivitiesImpl)) {
        const activityDef = wfDefs[activityName];
        if (!activityDef) {
          throw new ActivityDefinitionNotFoundError(
            `${workflowName}.${activityName}`,
            Object.keys(wfDefs),
          );
        }

        // Assign workflow activity directly at root level (flat structure)
        (wrappedActivities as Record<string, unknown>)[activityName] = makeWrapped(
          `${workflowName}.${activityName}`,
          { activityName, workflowName },
          activityDef,
          impl as (
            args: unknown,
            helpers: { errors: unknown; context: unknown },
          ) => AsyncResult<unknown, ApplicationFailure | AnyContractError>,
        );
      }
    }
  }

  return wrappedActivities;
}
