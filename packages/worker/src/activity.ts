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
  CONTRACT_ERROR_TAG,
  type AnyContractError,
  type ContractErrorConstructors,
  type ContractErrorInputUnion,
} from "@temporal-contract/contract/errors";
import { _internal_buildErrorConstructors } from "@temporal-contract/contract/internal";
import { ApplicationFailure } from "@temporalio/common";
import { P, type AsyncResult } from "unthrown";

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
 * An error-class constructor accepted by {@link QualifyFailureOptions.expected}.
 * `never[]` parameters make every concrete constructor assignable; the
 * `Error` return keeps the slot honest (only error classes belong here).
 */
type ErrorClass = abstract new (...args: never[]) => Error;

/**
 * Options for {@link qualifyFailure}. `expected` is **required** — it is the
 * triage decision that separates modeled failures from defects.
 */
export type QualifyFailureOptions = {
  /**
   * Which rejection causes are *anticipated* and should be wrapped into the
   * modeled {@link ApplicationFailure}:
   *
   * - an error-class constructor (matched with `instanceof`),
   * - an array of error-class constructors (any match wraps),
   * - a predicate `(cause: unknown) => boolean`,
   * - the literal `"any"` — a deliberate, greppable escape hatch that wraps
   *   every rejection (the pre-v8 blanket behavior).
   *
   * Anything that doesn't match rides unthrown's **defect** channel instead:
   * an unanticipated throw (a `TypeError` from a bug, an assertion failure)
   * is not a domain outcome, and blanket-wrapping it would disguise the bug
   * as the declared failure `type` and subject it to that type's retry
   * semantics.
   */
  expected: ErrorClass | readonly ErrorClass[] | ((cause: unknown) => boolean) | "any";
  /** Fallback message when the rejection is not an `Error` (default: `String(error)`). */
  message?: string;
  /**
   * Mark the failure non-retryable — Temporal stops retrying immediately.
   * When omitted, a matched cause that is itself an `ApplicationFailure`
   * with `nonRetryable: true` propagates its non-retryability (see
   * remarks); set `false` explicitly to force the wrapped failure retryable.
   */
  nonRetryable?: boolean;
  /** Structured payload forwarded to the workflow (avoids parsing `message`). */
  details?: unknown[];
};

/**
 * `true` when `expected` is an error-class constructor rather than a
 * predicate. Both are functions at runtime; classes are recognized by their
 * `Error`-derived prototype (predicates — arrow functions or plain functions
 * — never have one).
 */
function isErrorClass(
  expected: ErrorClass | ((cause: unknown) => boolean),
): expected is ErrorClass {
  if ((expected as unknown) === Error) return true;
  const proto: unknown = (expected as { prototype?: unknown }).prototype;
  return typeof proto === "object" && proto !== null && proto instanceof Error;
}

function matchesExpected(cause: unknown, expected: QualifyFailureOptions["expected"]): boolean {
  if (expected === "any") return true;
  if (Array.isArray(expected)) {
    return (expected as readonly ErrorClass[]).some((cls) => cause instanceof cls);
  }
  const single = expected as ErrorClass | ((cause: unknown) => boolean);
  if (isErrorClass(single)) {
    return cause instanceof single;
  }
  return single(cause);
}

/**
 * Build a qualifier for `fromPromise` that **triages** each rejection: causes
 * matching `options.expected` are wrapped in a modeled
 * {@link ApplicationFailure} of the given `errorType`; everything else goes
 * to unthrown's **defect** channel.
 *
 * Triage philosophy: `fromPromise`'s qualify step exists to force a per-cause
 * decision — *is this failure part of the activity's model, or a bug?* A
 * qualifier that wraps everything erases that decision: a `TypeError` from a
 * typo would surface as, say, `EMAIL_SEND_FAILED` and inherit its retry
 * semantics, hiding the defect from operators and from the defect channel's
 * fail-loud handling. `expected` is therefore **required**: name the failure
 * classes (or predicate) you anticipate; let the rest stay defects that
 * re-throw at the activity edge with their original cause. The literal
 * `expected: "any"` remains as an explicit, greppable escape hatch for the
 * old blanket behavior.
 *
 * For a matched `Error` cause, the wrapper keeps the cause's own message and
 * preserves it as `cause` (so stack traces survive the activity → workflow
 * boundary); a matched non-`Error` cause falls back to `options.message` (or
 * `String(cause)`).
 *
 * @example
 * ```ts
 * import { declareActivitiesHandler, qualifyFailure } from '@temporal-contract/worker/activity';
 * import { fromPromise } from 'unthrown';
 *
 * export const activities = declareActivitiesHandler({
 *   contract: myContract,
 *   activities: {
 *     sendEmail: ({ input: args }) =>
 *       fromPromise(
 *         emailService.send(args),
 *         // Anticipated: the SDK's typed error. Anything else (TypeError,
 *         // assertion failure, ...) is a defect and re-throws at the edge.
 *         qualifyFailure('EMAIL_SEND_FAILED', { expected: EmailServiceError }),
 *       ).map(() => ({ sent: true })),
 *     chargeCard: ({ input: args }) =>
 *       fromPromise(
 *         paymentGateway.charge(args),
 *         qualifyFailure('CARD_DECLINED', {
 *           // Several anticipated classes; a predicate works too.
 *           expected: [CardDeclinedError, GatewayTimeoutError],
 *           // Permanent failure: opt out of the configured retry policy.
 *           nonRetryable: true,
 *         }),
 *       ),
 *   },
 * });
 * ```
 *
 * @remarks
 * A matched cause is **always** wrapped — even when it is already an
 * `ApplicationFailure` — so the resulting failure's `type` is guaranteed to
 * be the declared one (retry policies keyed on
 * `retry.nonRetryableErrorTypes` can rely on it), with the original failure
 * preserved as `cause`. Retryability of the wrapper: when
 * `options.nonRetryable` is set it wins unconditionally; when it is omitted
 * and the matched cause is an `ApplicationFailure` with `nonRetryable: true`,
 * the wrapper inherits `nonRetryable: true` (a permanent inner failure no
 * longer silently becomes retryable just because it was re-typed).
 */
export function qualifyFailure(
  errorType: string,
  options: QualifyFailureOptions,
): <TDefect>(cause: unknown, defect: (cause: unknown) => TDefect) => ApplicationFailure | TDefect {
  return (cause, defect) => {
    if (!matchesExpected(cause, options.expected)) {
      return defect(cause);
    }
    // `nonRetryable` precedence: explicit option > inherited from a matched
    // non-retryable ApplicationFailure cause > Temporal default (retryable).
    const inheritedNonRetryable =
      cause instanceof ApplicationFailure && cause.nonRetryable === true ? true : undefined;
    const nonRetryable = options.nonRetryable ?? inheritedNonRetryable;
    return ApplicationFailure.create({
      type: errorType,
      message: cause instanceof Error ? cause.message : (options.message ?? String(cause)),
      ...(cause instanceof Error ? { cause } : {}),
      ...(nonRetryable !== undefined ? { nonRetryable } : {}),
      ...(options.details !== undefined ? { details: options.details } : {}),
    });
  };
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
 * First argument passed to every activity implementation — everything the
 * invocation carries, including its input.
 *
 * - `errors` — typed constructors for the errors declared on this activity's
 *   contract entry. `Err(errors.PaymentDeclined({ reason }))` surfaces to the
 *   calling workflow as a typed, schema-validated error.
 * - `context` — the accumulated typed context: the `createContext` seed
 *   plus everything injected by the middleware chain via
 *   `next({ context })` (an empty object when neither is configured). Use
 *   it to inject dependencies (service clients, repositories) instead of
 *   closing over them at module scope.
 * - `input` — the validated input, the SAME value the second parameter
 *   carries. It is on the record so a whole implementation is one
 *   destructuring, which is oRPC's own shape and its own word for it
 *   (`ProcedureHandlerOptions` carries `input`, and the handler still takes it
 *   positionally). One name across the three transports is the point: a
 *   developer moving between them destructures `input` in each.
 */
export type ActivityImplementationHelpers<
  TActivity extends ActivityDefinition,
  TContext extends Record<string, unknown> | EmptyContext = EmptyContext,
> = {
  readonly errors: ActivityErrorConstructorsOf<TActivity>;
  readonly context: TContext;
  readonly input: WorkerInferInput<TActivity>;
  /**
   * The activity's idempotency key for this invocation — `string` when the
   * contract declares `idempotencyKey`, and `undefined` when it does not, so
   * reaching for a key that was never declared is a type error rather than a
   * silent `undefined` reaching a payment gateway.
   *
   * Derived from the validated input, verbatim. Stable across retries of
   * this activity, across worker crashes, and across a fresh workflow
   * execution with the same input — see `idempotencyKey` on the contract's
   * `defineActivity`.
   */
  readonly idempotencyKey: ActivityIdempotencyKeyOf<TActivity>;
};

/**
 * `string` for an activity that declares `idempotencyKey`, `undefined` for
 * one that does not.
 */
export type ActivityIdempotencyKeyOf<TActivity extends ActivityDefinition> =
  TActivity["idempotencyKey"] extends (input: never) => string ? string : undefined;

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
 * **One record, everything on it** — oRPC's shape, which this family converged
 * on: `({ errors, input }) => ...` is the spelling to reach for, and the input
 * is repeated as a second positional parameter for a caller who prefers
 * `({ errors }, args) => ...`.
 */
type ResultActivityImplementation<
  TActivity extends ActivityDefinition,
  TContext extends Record<string, unknown> | EmptyContext = EmptyContext,
> = (
  helpers: ActivityImplementationHelpers<TActivity, TContext>,
  args: WorkerInferInput<TActivity>,
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
 *
 * Workflows that declare **no activities** are filtered out of the map via
 * key remapping — they don't require (or accept) an empty `workflowName: {}`
 * placeholder entry.
 */
type ContractResultActivitiesImplementations<
  TContract extends ContractDefinition,
  TContext extends Record<string, unknown> | EmptyContext = EmptyContext,
> =
  // Global activities
  (TContract["activities"] extends Record<string, ActivityDefinition>
    ? ResultActivitiesImplementations<TContract["activities"], TContext>
    : {}) &
    // All workflow-specific activities merged; workflows without activities
    // are remapped away entirely instead of demanding a `{}` entry.
    {
      [
        TWorkflow in keyof TContract["workflows"] as WorkflowHasActivities<
          TContract["workflows"][TWorkflow]
        > extends true
          ? TWorkflow
          : never
      ]: TContract["workflows"][TWorkflow]["activities"] extends Record<string, ActivityDefinition>
        ? ResultActivitiesImplementations<TContract["workflows"][TWorkflow]["activities"], TContext>
        : never;
    };

/**
 * `true` when a workflow definition declares a non-empty `activities` map.
 * Drives the key remapping in {@link ContractResultActivitiesImplementations}
 * so activity-less workflows don't demand placeholder `{}` entries in the
 * implementations map. An absent map and an explicitly empty `activities: {}`
 * both count as "no activities".
 */
type WorkflowHasActivities<TWorkflow> = TWorkflow extends {
  activities: infer TActivities extends Record<string, ActivityDefinition>;
}
  ? [keyof TActivities] extends [never]
    ? false
    : true
  : false;

type ResultActivitiesImplementations<
  TActivities extends Record<string, ActivityDefinition>,
  TContext extends Record<string, unknown> | EmptyContext = EmptyContext,
> = {
  [K in keyof TActivities]: ResultActivityImplementation<TActivities[K], TContext>;
};

/**
 * The correctly-typed implementation function for one **workflow-local**
 * activity of a contract. Lets a standalone implementation typecheck outside
 * the `declareActivitiesHandler` call so it can live in its own module (with
 * precise `args`/`helpers` inference) and be assigned into the nested
 * implementations map later:
 *
 * @example
 * ```ts
 * const validateOrder: ActivityImplementationFor<
 *   typeof myContract,
 *   "orderWorkflow",
 *   "validateOrder"
 * > = ({ errors, input }) =>
 *   input.orderId ? OkAsync({ valid: true }) : ErrAsync(errors.EmptyOrder({}));
 *
 * declareActivitiesHandler({
 *   contract: myContract,
 *   activities: { orderWorkflow: { validateOrder } },
 * });
 * ```
 *
 * The optional `TContext` parameter mirrors the handler's injected context
 * (`createContext` seed + middleware accumulation); leave it defaulted when
 * the implementation doesn't read `helpers.context`.
 *
 * See {@link GlobalActivityImplementationFor} for the contract-global
 * variant.
 */
export type ActivityImplementationFor<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
  TActivityName extends keyof TContract["workflows"][TWorkflowName]["activities"] & string,
  TContext extends Record<string, unknown> | EmptyContext = EmptyContext,
> =
  TContract["workflows"][TWorkflowName]["activities"] extends Record<string, ActivityDefinition>
    ? ResultActivityImplementation<
        TContract["workflows"][TWorkflowName]["activities"][TActivityName],
        TContext
      >
    : never;

/**
 * The correctly-typed implementation function for one **global** activity of
 * a contract — the `contract.activities`-scoped sibling of
 * {@link ActivityImplementationFor}.
 *
 * @example
 * ```ts
 * const sendEmail: GlobalActivityImplementationFor<typeof myContract, "sendEmail"> =
 *   ({ input: args }) => OkAsync({ sent: true });
 * ```
 */
export type GlobalActivityImplementationFor<
  TContract extends ContractDefinition,
  TActivityName extends keyof TContract["activities"] & string,
  TContext extends Record<string, unknown> | EmptyContext = EmptyContext,
> =
  TContract["activities"] extends Record<string, ActivityDefinition>
    ? ResultActivityImplementation<TContract["activities"][TActivityName], TContext>
    : never;

/**
 * Per-invocation description handed to middleware and `createContext`.
 */
export type ActivityInvocationInfo = {
  /** Flat runtime name of the activity (as Temporal sees it). */
  readonly activityName: string;
  /**
   * Owning workflow for workflow-local activities; `undefined` for global
   * ones.
   *
   * **Shared-definition caveat:** `workflowName` identifies the scope the
   * implementation was *registered under*, not the workflow that is calling
   * right now (Temporal's flat activity namespace erases the caller). When
   * one `defineActivity` object is referenced from several scopes and
   * implemented with the same function reference, the activity registers
   * once under the first scope encountered — global first, then the
   * contract's workflow declaration order — and every invocation reports
   * that scope's `workflowName`. To know the actual calling workflow inside
   * an activity, read `Context.current().info.workflowType` from
   * `@temporalio/activity`.
   */
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
 * without a variable annotation via {@link declareActivityMiddleware}.
 *
 * @example Log every activity invocation and its outcome (read-only)
 * ```ts
 * import { ApplicationFailure } from '@temporal-contract/worker/activity';
 * import { P } from "unthrown";
 *
 * const logging: ActivityMiddleware = ({ activityName, workflowName }, next) =>
 *   next().tapErrCases((matcher) =>
 *     matcher.with(
 *       P.instanceOf(ApplicationFailure),
 *       P.tag("@temporal-contract/ContractError"),
 *       (error) => {
 *         logger.warn({ activityName, workflowName, error }, "activity failed");
 *       },
 *     ),
 *   );
 * ```
 *
 * @example Guard-and-narrow: inject a tenant id for everything downstream
 * ```ts
 * const auth = declareActivityMiddleware<EmptyContext, { tenantId: string }>(
 *   (invocation, next) => {
 *     const tenantId = readTenant(invocation.input);
 *     if (!tenantId) {
 *       return ErrAsync(ApplicationFailure.create({ type: "Unauthenticated", nonRetryable: true }));
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
export function declareActivityMiddleware<
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
 * Options for {@link declareActivitiesHandler}.
 */
export type DeclareActivitiesHandlerOptions<
  TContract extends ContractDefinition,
  TContext extends Record<string, unknown> | EmptyContext = EmptyContext,
  TInjected extends TContext = TContext,
> = {
  contract: TContract;
  /**
   * Nested implementations map mirroring the contract's structure — see
   * {@link ContractResultActivitiesImplementations}.
   *
   * Wrapped in `NoInfer` so `TContract`/`TInjected` are inferred from
   * `contract`/`middleware` only: letting TypeScript infer *into* the
   * key-remapped mapped type breaks contextual typing of the implementation
   * lambdas (their `args` degrade to implicit `any`).
   */
  activities: NoInfer<ContractResultActivitiesImplementations<TContract, TInjected>>;
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
        [
          TWorkflow in keyof TContract["workflows"]
        ]: TContract["workflows"][TWorkflow]["activities"] extends Record<
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
 * import { myContract } from './contract.js';
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
 *           // Temporal stops retrying immediately. Note the conditional
 *           // spread for `cause` — under `exactOptionalPropertyTypes`,
 *           // omit the key entirely rather than passing `undefined`.
 *           ApplicationFailure.create({
 *             type: 'EMAIL_SEND_FAILED',
 *             message: 'Failed to send email',
 *             nonRetryable: false,
 *             ...(error instanceof Error ? { cause: error } : {}),
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
 * // Wire into a worker with this package's typed factory — the task queue
 * // comes from the contract.
 * import { NativeConnection } from '@temporalio/worker';
 * import { TypedWorker, workflowsPathFromURL } from '@temporal-contract/worker/worker';
 *
 * const connection = await NativeConnection.connect({ address: 'localhost:7233' });
 * const worker = await TypedWorker.create({
 *   contract: myContract,
 *   connection,
 *   workflowsPath: workflowsPathFromURL(import.meta.url, './workflows.js'),
 *   activities,
 * }).get();
 * ```
 *
 * @remarks
 * The wrapper accepts implementations in the
 * `AsyncResult<T, ApplicationFailure | declared errors>` shape and produces
 * ordinary Promise-returning Temporal handlers (`Err(ApplicationFailure)` →
 * thrown; `Err(ContractError)` → data validated against the declared schema
 * and thrown as an `ApplicationFailure` with `type` = error name,
 * `details[0]` = data, `nonRetryable` from the contract; `Ok(...)` → output
 * validated against the contract, then resolved with the implementation's
 * original value — the calling side parses it on receive; `defect` →
 * original cause re-thrown). It does **not** hide Temporal's
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

  /**
   * The declared idempotency key for one invocation, or `undefined` when the
   * activity declares none.
   *
   * Handed over **verbatim** — no activity-name prefix. Prefixing would make
   * the key the implementation sees differ from the one the derivation
   * function returns, and `runActivity` (which has a definition but no runtime
   * activity name) could not reproduce it, so a unit test would exercise a
   * different key than production. An activity sharing a downstream keyspace
   * with another should say so in its own derivation: `` `charge:${orderId}` ``.
   */
  function deriveIdempotencyKey(
    activityDef: ActivityDefinition,
    input: unknown,
  ): string | undefined {
    // The structural slot types its parameter `never` so plain-object contracts
    // stay assignable (see `ActivityDefinition`); the value passed here is the
    // validated input the derivation was written against.
    const derive = activityDef.idempotencyKey as ((input: unknown) => string) | undefined;
    return derive?.(input);
  }

  // Helper to create a wrapped implementation from a definition and impl.
  // `label` is the diagnostic name used in validation errors (workflow-local
  // activities keep the historical `workflow.activity` format); `info` is the
  // runtime identity handed to middleware and `createContext`.
  function makeWrapped(
    label: string,
    info: ActivityInvocationInfo,
    activityDef: ActivityDefinition,
    activityImpl: (
      helpers: { errors: unknown; context: unknown; input: unknown; idempotencyKey: unknown },
      args: unknown,
    ) => AsyncResult<unknown, ApplicationFailure | AnyContractError>,
  ) {
    // Constructors are stateless and derived from contract-time immutables,
    // so build them once per activity at declaration time.
    const errorConstructors = _internal_buildErrorConstructors(activityDef.errors);

    return async (...args: unknown[]) => {
      const input = extractHandlerInput(args);

      // Parse input. This is the RECEIVING side of the boundary: the
      // workflow-side proxy (or typed client) validated the payload but
      // transmitted the caller's original value, so the parse (and any
      // schema transform) happens exactly once, here.
      const inputResult = await activityDef.input["~standard"].validate(input);
      if (inputResult.issues) {
        // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
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
        activityImpl(
          {
            errors: errorConstructors,
            context: stageContext,
            input: stageInput,
            // Derived from the input the implementation is about to see —
            // `stageInput`, not the caller's original — so a middleware
            // `next({ input })` substitution (already re-validated above)
            // keys the downstream call on what actually ran.
            idempotencyKey: deriveIdempotencyKey(activityDef, stageInput),
          },
          stageInput,
        );

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
                // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: thrown inside the makeAsyncResult work thunk so Temporal sees the terminal failure (CLAUDE.md rule 2 exception)
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
          // Validate the output, but hand Temporal the implementation's
          // ORIGINAL value — the consuming side (workflow proxy / typed
          // client) parses the result, so a transforming output schema is
          // applied exactly once, on receive.
          const outputResult = await activityDef.output["~standard"].validate(value);
          if (outputResult.issues) {
            // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
            throw new ActivityOutputValidationError(label, outputResult.issues);
          }
          return value;
        },
        // Convert Err(...) payload to thrown ApplicationFailure for Temporal.
        // Temporal recognizes this class natively and applies the configured
        // retry policy (honoring `nonRetryable: true`). Contract errors are
        // validated against their declared data schema and serialized as
        // ApplicationFailure(type = error name, details = [data]).
        errCases: (matcher) =>
          matcher
            .with(P.tag(CONTRACT_ERROR_TAG), async (error) => {
              // oxlint-disable-next-line unthrown/no-throw -- sanctioned ApplicationFailure model: the Err payload is thrown at the activity boundary so Temporal applies its retry policy (CLAUDE.md rule 2 exception)
              throw await contractErrorToApplicationFailure(
                error,
                activityDef.errors,
                `activity "${label}"`,
              );
            })
            .with(P.instanceOf(ApplicationFailure), (error) => {
              // oxlint-disable-next-line unthrown/no-throw -- sanctioned ApplicationFailure model: the Err payload is thrown at the activity boundary so Temporal applies its retry policy (CLAUDE.md rule 2 exception)
              throw error;
            }),
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
          // oxlint-disable-next-line unthrown/no-throw -- defect-channel edge: re-throw the unmodeled cause unwrapped so Temporal's default (retryable) handling applies
          throw cause;
        },
      });
    };
  }

  type ErasedImplementation = (
    helpers: { errors: unknown; context: unknown; input: unknown; idempotencyKey: unknown },
    args: unknown,
  ) => AsyncResult<unknown, ApplicationFailure | AnyContractError>;

  const implementationMap = activities as Record<string, unknown>;
  const workflowDefs = contract.workflows ?? {};

  // 0) Defense-in-depth: a global activity sharing a workflow's name makes
  // the root of this implementations map ambiguous. `defineContract`
  // rejects this too; the check is repeated here for contracts built as
  // plain object literals (or from JavaScript) that never went through
  // `defineContract`. The message is aligned with the contract-side one.
  if (contract.activities) {
    for (const activityName of Object.keys(contract.activities)) {
      if (Object.hasOwn(workflowDefs, activityName)) {
        // oxlint-disable-next-line unthrown/no-throw -- declaration-time fail-fast config error: worker startup must abort on an ambiguous implementations map
        throw new Error(
          `global activity "${activityName}" has the same name as a workflow. Workflows and global activities share the root of the worker implementations map — rename one of them.`,
        );
      }
    }
  }

  // Iterate the contract DEFINITIONS (not just the provided implementations)
  // so a declared-but-missing implementation fails fast at declaration time
  // with a clear error, instead of surfacing as an opaque "activity not
  // registered" failure the first time Temporal dispatches a task for it.
  const missingImplementations: string[] = [];

  // Flat-namespace bookkeeping: `defineContract` allows one `defineActivity`
  // object to be referenced from several scopes (it's one activity), so the
  // same flat name can legitimately appear here more than once. What must
  // NOT happen is a silent last-wins overwrite of a *different* function —
  // one scope's implementation would clobber the other's. Track who
  // registered each flat name (and with which raw implementation) so a
  // duplicate either dedupes (same function reference — first registration
  // wins, see the `ActivityInvocationInfo.workflowName` caveat) or throws.
  const registrations = new Map<string, { scopeLabel: string; impl: unknown }>();

  /**
   * Returns `true` when the caller should register `impl` under
   * `activityName`, `false` when an identical registration already exists
   * (silent dedupe). Throws on a conflicting duplicate.
   */
  function shouldRegister(activityName: string, scopeLabel: string, impl: unknown): boolean {
    const existing = registrations.get(activityName);
    if (!existing) {
      registrations.set(activityName, { scopeLabel, impl });
      return true;
    }
    if (existing.impl === impl) {
      // Same function reference from another scope — one activity, one
      // implementation. Keep the first registration.
      return false;
    }
    // oxlint-disable-next-line unthrown/no-throw -- declaration-time fail-fast config error: worker startup must abort instead of silently clobbering a shared activity implementation
    throw new Error(
      `declareActivitiesHandler: activity "${activityName}" received two different implementations — ` +
        `one from ${existing.scopeLabel} and one from ${scopeLabel}. Activities share a single flat ` +
        `namespace at runtime, so the second implementation would silently replace the first. ` +
        `Either hoist the shared activity to the contract's global \`activities\` block and implement ` +
        `it once at the root level, or pass the exact same implementation function reference from ` +
        `every scope that declares it.`,
    );
  }

  // 1) Global activities declared under contract.activities.
  if (contract.activities) {
    for (const [activityName, activityDef] of Object.entries(contract.activities)) {
      const impl = implementationMap[activityName];
      if (typeof impl !== "function") {
        missingImplementations.push(activityName);
        continue;
      }

      // Assign wrapped global activity
      if (shouldRegister(activityName, "the global scope", impl)) {
        (wrappedActivities as Record<string, unknown>)[activityName] = makeWrapped(
          activityName,
          { activityName, workflowName: undefined },
          activityDef,
          impl as ErasedImplementation,
        );
      }
    }
  }

  // 2) Workflow-scoped activities, flattened to the root level.
  for (const [workflowName, workflowDef] of Object.entries(workflowDefs)) {
    const wfDefs = workflowDef.activities ?? {};
    const wfActivitiesImpl = implementationMap[workflowName] as Record<string, unknown> | undefined;

    for (const [activityName, activityDef] of Object.entries(wfDefs)) {
      const impl = wfActivitiesImpl?.[activityName];
      if (typeof impl !== "function") {
        missingImplementations.push(`${workflowName}.${activityName}`);
        continue;
      }

      // Assign workflow activity directly at root level (flat structure).
      // `shouldRegister` dedupes a shared-definition re-registration (same
      // function reference) and throws on a conflicting one.
      if (shouldRegister(activityName, `workflow "${workflowName}"`, impl)) {
        (wrappedActivities as Record<string, unknown>)[activityName] = makeWrapped(
          `${workflowName}.${activityName}`,
          { activityName, workflowName },
          activityDef,
          impl as ErasedImplementation,
        );
      }
    }

    // Stray keys inside a workflow namespace: implementations for activities
    // the workflow never declared.
    if (wfActivitiesImpl) {
      for (const activityName of Object.keys(wfActivitiesImpl)) {
        if (!Object.hasOwn(wfDefs, activityName)) {
          // oxlint-disable-next-line unthrown/no-throw -- declaration-time fail-fast config error: worker startup must abort on an implementation for an undeclared activity
          throw new ActivityDefinitionNotFoundError(
            `${workflowName}.${activityName}`,
            Object.keys(wfDefs),
          );
        }
      }
    }
  }

  if (missingImplementations.length > 0) {
    // oxlint-disable-next-line unthrown/no-throw -- declaration-time fail-fast config error: worker startup must abort on missing activity implementations
    throw new Error(
      `declareActivitiesHandler: missing implementation${missingImplementations.length > 1 ? "s" : ""} ` +
        `for declared activit${missingImplementations.length > 1 ? "ies" : "y"}: ` +
        `${missingImplementations.join(", ")}. Every activity declared on the contract must be implemented.`,
    );
  }

  // 3) Stray root-level keys: anything that is neither a declared global
  // activity nor a workflow namespace is a typo (or a stale entry from a
  // renamed activity). This check runs whether or not `contract.activities`
  // exists — an unknown key is an error either way.
  for (const key of Object.keys(implementationMap)) {
    if (Object.hasOwn(workflowDefs, key)) continue; // workflow namespace, validated above
    if (contract.activities && Object.hasOwn(contract.activities, key)) continue;
    // oxlint-disable-next-line unthrown/no-throw -- declaration-time fail-fast config error: worker startup must abort on a stray implementation key
    throw new ActivityDefinitionNotFoundError(key, Object.keys(contract.activities ?? {}));
  }

  return wrappedActivities;
}
