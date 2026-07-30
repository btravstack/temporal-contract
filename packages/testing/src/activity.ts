/**
 * Docker-free unit testing of a single activity implementation.
 *
 * {@link runActivity} executes one activity implementation (the
 * `AsyncResult`-returning functions passed to `declareActivitiesHandler`)
 * inside `@temporalio/testing`'s `MockActivityEnvironment`, so
 * `Context.current()` works — heartbeats are observable and cancellation can
 * be triggered — without a worker, a server, or Docker. It builds the typed
 * error constructors from the activity's contract definition, mirroring what
 * the worker hands implementations at runtime.
 *
 * This entry deliberately avoids `vitest` — it only needs
 * `@temporalio/testing` — so it can be used from any test runner.
 */
import type {
  ActivityDefinition,
  ErrorDefinition,
  WorkerInferInput,
} from "@temporal-contract/contract";
import {
  _internal_buildErrorConstructors,
  type ContractErrorConstructors,
} from "@temporal-contract/contract/errors";
import { _internal_makeAsyncResult } from "@temporal-contract/contract/result-async";
import { MockActivityEnvironment } from "@temporalio/testing";
import type { AsyncResult } from "unthrown";

/**
 * Typed error constructors for an activity's declared `errors` map — the
 * `errors` helper handed to the implementation, mirroring the worker's
 * runtime behavior. Empty for activities that declare no errors.
 */
type ActivityErrorConstructorsOf<TActivity extends ActivityDefinition> = TActivity extends {
  errors: infer TErrors extends Record<string, ErrorDefinition>;
}
  ? ContractErrorConstructors<TErrors>
  : Record<string, never>;

/**
 * Shape of the implementation accepted by {@link runActivity} — the same
 * `(args, helpers) => AsyncResult<...>` shape `declareActivitiesHandler`
 * expects, with the output/error channels inferred from the function itself.
 * The `context` helper is always empty here: implementations relying on
 * middleware-injected context should be exercised through a worker instead.
 */
export type RunActivityImplementation<TActivity extends ActivityDefinition, TOutput, TError> = (
  args: WorkerInferInput<TActivity>,
  helpers: {
    readonly errors: ActivityErrorConstructorsOf<TActivity>;
    readonly context: Record<never, never>;
  },
) => AsyncResult<TOutput, TError>;

/**
 * Options for {@link runActivity}.
 */
export type RunActivityOptions = {
  /**
   * Reuse a prepared `MockActivityEnvironment` — pass one to observe
   * heartbeats (`env.on("heartbeat", ...)`), trigger cancellation
   * (`env.cancel()`), or customize the activity info. A fresh default
   * environment is created when omitted.
   */
  env?: MockActivityEnvironment;
};

/**
 * Execute a single activity implementation against its contract definition
 * inside a `MockActivityEnvironment`, returning the implementation's
 * `AsyncResult` untouched: `Ok`/`Err` flow through as-is, and an
 * unanticipated throw (including a `CancelledFailure` from cancellation)
 * surfaces on the `defect` channel.
 *
 * @example
 * ```ts
 * import { runActivity } from "@temporal-contract/testing/activity";
 *
 * const result = await runActivity(
 *   orderContract.workflows.processOrder.activities.chargeCard,
 *   chargeCard, // (args, { errors }) => AsyncResult<...>
 *   { amount: 100 },
 * );
 *
 * expect(result.isOk()).toBe(true);
 * ```
 *
 * @param definition - The activity's contract definition (used to build the
 * typed `errors` constructors handed to the implementation).
 * @param implementation - The activity implementation under test.
 * @param input - The activity input, in the parsed shape the worker would
 * hand the implementation.
 * @param options - See {@link RunActivityOptions}.
 */
export function runActivity<TActivity extends ActivityDefinition, TOutput, TError>(
  definition: TActivity,
  implementation: RunActivityImplementation<TActivity, TOutput, TError>,
  input: WorkerInferInput<TActivity>,
  options?: RunActivityOptions,
): AsyncResult<TOutput, TError> {
  const env = options?.env ?? new MockActivityEnvironment();
  const helpers = {
    errors: _internal_buildErrorConstructors(
      definition.errors,
    ) as unknown as ActivityErrorConstructorsOf<TActivity>,
    context: {},
  };

  return _internal_makeAsyncResult(() =>
    env.run(async () => {
      // Awaiting the AsyncResult yields its settled Result (ok / err /
      // defect) without throwing; the outer wrapper re-lifts it, and any
      // synchronous throw or rejection lands on the defect channel.
      return await implementation(input, helpers);
    }),
  );
}
