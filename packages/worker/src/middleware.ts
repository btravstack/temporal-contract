/**
 * Contract-aware activity middleware: the types handed to middleware and
 * `createContext`, and the typed composition helpers. Re-exported from the
 * `./activity` entry point.
 */
import type { AnyContractError } from "@temporal-contract/contract/errors";
import type { ApplicationFailure } from "@temporalio/common";
import type { AsyncResult } from "unthrown";

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
