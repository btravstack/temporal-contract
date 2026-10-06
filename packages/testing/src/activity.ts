/**
 * Docker-free unit testing of a single activity implementation.
 *
 * Two entry points, two altitudes:
 *
 * - {@link runActivity} executes one activity implementation (the
 *   `AsyncResult`-returning functions passed to `declareActivitiesHandler`)
 *   inside `@temporalio/testing`'s `MockActivityEnvironment`, so
 *   `Context.current()` works — heartbeats are observable and cancellation
 *   can be triggered — without a worker, a server, or Docker. The
 *   implementation's `AsyncResult` flows through **untouched**: no input
 *   parse, no output validation, no contract-error conversion. Use it for
 *   pure-logic unit tests.
 * - {@link runActivityHandler} routes the same implementation through the
 *   **real** `declareActivitiesHandler` wrapping — input parse →
 *   implementation → output validation → contract-error → `ApplicationFailure`
 *   wire conversion — then rehydrates the wire failure back into a typed
 *   `Result`, exercising the full round-trip a workflow-side caller sees,
 *   payload serialization included.
 *   Use it for boundary-faithful tests: it fails where production fails
 *   (schema drift, undeclared error names, invalid error data) even when the
 *   raw implementation's `Result` looks fine.
 *
 * This entry deliberately avoids `vitest` — it only needs
 * `@temporalio/testing` and `@temporalio/worker` — so it can be used from
 * any test runner.
 */
import type {
  ActivityDefinition,
  ClientInferInput,
  ClientInferOutput,
  ErrorDefinition,
  WorkerInferInput,
} from "@temporal-contract/contract";
import { type ContractErrorUnion } from "@temporal-contract/contract/errors";
import {
  _internal_buildErrorConstructors,
  _internal_makeAsyncResult,
  _internal_rehydrateContractError,
} from "@temporal-contract/contract/internal";
import {
  declareActivitiesHandler,
  ActivityOutputValidationError,
  ApplicationFailure,
  type ActivityImplementationHelpers,
} from "@temporal-contract/worker/activity";
import { MockActivityEnvironment } from "@temporalio/testing";
import { defaultPayloadConverter } from "@temporalio/worker";
import { Err, Ok, type AsyncResult } from "unthrown";

/**
 * Shape of the implementation accepted by {@link runActivity} and
 * {@link runActivityHandler} — the same `(helpers, args) => AsyncResult<...>`
 * shape `declareActivitiesHandler` expects, with the output/error channels
 * inferred from the function itself. The `context` helper is always empty
 * here: implementations relying on middleware-injected context should be
 * exercised through a worker instead.
 */
export type RunActivityImplementation<TActivity extends ActivityDefinition, TOutput, TError> = (
  helpers: ActivityImplementationHelpers<TActivity>,
  args: WorkerInferInput<TActivity>,
) => AsyncResult<TOutput, TError>;

/**
 * Options for {@link runActivity}.
 */
export type RunActivityOptions<TActivity extends ActivityDefinition, TOutput, TError> = {
  /** The activity implementation under test. */
  implementation: RunActivityImplementation<TActivity, TOutput, TError>;
  /**
   * The activity input, in the parsed shape the worker would hand the
   * implementation.
   */
  input: WorkerInferInput<TActivity>;
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
 * This is the **pure-logic** tier: no input parse, no output validation, no
 * contract-error wire conversion. A test that passes here can still fail at
 * the production boundary (e.g. an `Err` whose data violates the declared
 * schema) — cover that with {@link runActivityHandler}.
 *
 * @example
 * ```ts
 * import { runActivity } from "@temporal-contract/testing/activity";
 *
 * const result = await runActivity(
 *   orderContract.workflows.processOrder.activities.chargeCard,
 *   {
 *     implementation: chargeCard, // ({ errors, input }) => AsyncResult<...>
 *     input: { amount: 100 },
 *   },
 * );
 *
 * await expect(result).toBeOk(); // with @unthrown/vitest matchers
 * ```
 *
 * @param definition - The activity's contract definition (used to build the
 * typed `errors` constructors handed to the implementation).
 * @param options - See {@link RunActivityOptions}.
 */
export function runActivity<TActivity extends ActivityDefinition, TOutput, TError>(
  definition: TActivity,
  options: RunActivityOptions<TActivity, TOutput, TError>,
): AsyncResult<TOutput, TError> {
  const env = options.env ?? new MockActivityEnvironment();
  const helpers = {
    errors: _internal_buildErrorConstructors(definition.errors),
    context: {},
    input: options.input,
    // Same value production hands over: the declared derivation applied to
    // this input, verbatim. The structural slot types its parameter `never`
    // so plain-object contracts stay assignable (see `ActivityDefinition`);
    // the value passed here is the input the derivation was written against.
    idempotencyKey: (definition.idempotencyKey as ((input: unknown) => string) | undefined)?.(
      options.input,
    ),
  } as unknown as ActivityImplementationHelpers<TActivity>;

  return _internal_makeAsyncResult(() =>
    env.run(async () => {
      // Awaiting the AsyncResult yields its settled Result (ok / err /
      // defect) without throwing; the outer wrapper re-lifts it, and any
      // synchronous throw or rejection lands on the defect channel.
      return await options.implementation(helpers, options.input);
    }),
  );
}

/**
 * Error channel surfaced by {@link runActivityHandler}: the activity's
 * declared errors **rehydrated** to their consumer-side (post-transform)
 * shape — exactly what the workflow-side proxy would produce — plus
 * `ApplicationFailure` for everything else that crossed the boundary
 * (technical failures returned by the implementation, and the worker's
 * terminal validation failures: `ActivityInputValidationError`,
 * `ActivityOutputValidationError`, `ContractErrorDataValidationError`,
 * `ContractMisuseError` — all `ApplicationFailure` subclasses,
 * discriminable via `failure.type`).
 */
export type RunActivityHandlerError<TActivity extends ActivityDefinition> = TActivity extends {
  errors: infer TErrors extends Record<string, ErrorDefinition>;
}
  ? ContractErrorUnion<TErrors> | ApplicationFailure
  : ApplicationFailure;

/**
 * Options for {@link runActivityHandler}.
 */
export type RunActivityHandlerOptions<TActivity extends ActivityDefinition, TOutput, TError> = {
  /**
   * The activity implementation under test — the same function you would
   * pass to `declareActivitiesHandler`.
   */
  implementation: RunActivityImplementation<TActivity, TOutput, TError>;
  /**
   * The activity input as a **caller** would send it (the wire value, in the
   * input schema's pre-transform shape) — the handler parses it, exactly
   * like production.
   */
  input: ClientInferInput<TActivity>;
  /**
   * Diagnostic name used in validation-error messages (mirrors the flat
   * runtime activity name).
   *
   * @defaultValue `"activity"`
   */
  activityName?: string;
  /**
   * Reuse a prepared `MockActivityEnvironment` — same semantics as
   * {@link RunActivityOptions.env}.
   */
  env?: MockActivityEnvironment;
  /**
   * The payload converter the input, the output and the failure details
   * round-trip through, as they would between a workflow and a worker —
   * pass the one your worker and client are configured with.
   *
   * @defaultValue `defaultPayloadConverter` from `@temporalio/worker`
   */
  payloadConverter?: Pick<typeof defaultPayloadConverter, "fromPayload" | "toPayload">;
};

/**
 * Execute a single activity implementation through the **real**
 * `declareActivitiesHandler` wrapping inside a `MockActivityEnvironment`,
 * then classify the outcome the way a workflow-side caller would:
 *
 * - the wire input is parsed against the contract's input schema (an invalid
 *   input surfaces the production `ActivityInputValidationError`);
 * - the input, the output and the failure details round-trip through the
 *   payload converter, so a value that does not survive serialization (a
 *   `Date` becomes a string under the default JSON converter) fails here
 *   as it would in production;
 * - the implementation's `Ok` output is validated on the sending side and
 *   parsed on the receiving side, so a transforming output schema applies
 *   exactly once — and drift from the schema, on either side, surfaces the
 *   production `ActivityOutputValidationError`;
 * - a typed `Err(errors.X(data))` is converted to its `ApplicationFailure`
 *   wire shape (`type` = error name, `details[0]` = data, `details[1]` =
 *   the provenance wire marker) and **rehydrated** back into the typed
 *   `ContractError` — the full wire round-trip;
 * - contract misuse surfaces the production terminal failure instead of a
 *   green test: `ContractMisuseError` for an undeclared error name,
 *   `ContractErrorDataValidationError` for error data failing its declared
 *   schema;
 * - an unanticipated throw stays on the `defect` channel.
 *
 * Use {@link runActivity} for pure-logic unit tests of the implementation;
 * use this when the test should be **boundary-faithful** — passing here
 * means the same call succeeds through a real worker.
 *
 * @example
 * ```ts
 * import { runActivityHandler } from "@temporal-contract/testing/activity";
 *
 * const result = await runActivityHandler(
 *   orderContract.workflows.processOrder.activities.chargeCard,
 *   {
 *     implementation: chargeCard,
 *     input: { amount: -1 },
 *   },
 * );
 *
 * // The declared error crossed the wire and rehydrated as a typed error.
 * await expect(result).toBeErrTagged("@temporal-contract/ContractError");
 * ```
 *
 * @param definition - The activity's contract definition.
 * @param options - See {@link RunActivityHandlerOptions}.
 */
export function runActivityHandler<TActivity extends ActivityDefinition, TOutput, TError>(
  definition: TActivity,
  options: RunActivityHandlerOptions<TActivity, TOutput, TError>,
): AsyncResult<ClientInferOutput<TActivity>, RunActivityHandlerError<TActivity>> {
  const env = options.env ?? new MockActivityEnvironment();
  const activityName = options.activityName ?? "activity";

  // Reuse the production wrapping end-to-end: a synthetic single-activity
  // contract routed through `declareActivitiesHandler` yields the exact
  // wrapped handler a worker would register (input parse → implementation →
  // output validation → contract-error wire conversion). No validation logic
  // is reimplemented here.
  const syntheticContract = {
    taskQueue: "run-activity-handler",
    workflows: {},
    activities: { [activityName]: definition },
  } as unknown as Parameters<typeof declareActivitiesHandler>[0]["contract"];
  const handler = declareActivitiesHandler({
    contract: syntheticContract,
    activities: {
      [activityName]: options.implementation,
    } as unknown as Parameters<typeof declareActivitiesHandler>[0]["activities"],
  });
  const wrapped = (handler as Record<string, (...args: unknown[]) => Promise<unknown>>)[
    activityName
  ]!;

  const converter = options.payloadConverter ?? defaultPayloadConverter;
  const overTheWire = (value: unknown): unknown =>
    converter.fromPayload(converter.toPayload(value));

  return _internal_makeAsyncResult(async () => {
    let wireOutput: unknown;
    try {
      wireOutput = overTheWire(await env.run(() => wrapped(overTheWire(options.input))));
    } catch (error) {
      if (error instanceof ApplicationFailure) {
        // The failure was built for this call, so its details are rewritten
        // in place to their received shape (keeping the subclass intact).
        (error as { details?: unknown }).details = error.details?.map(overTheWire);
        // Receiving side of the failure boundary: a declared error name whose
        // payload validates (with the wire marker corroborating provenance)
        // rehydrates into the typed ContractError; anything else — including
        // the worker's terminal validation failures — stays the raw
        // ApplicationFailure, discriminable via `failure.type`.
        const rehydrated = await _internal_rehydrateContractError(definition.errors, error);
        return Err((rehydrated ?? error) as RunActivityHandlerError<TActivity>);
      }
      // Unanticipated throw (a bug, or cancellation) — re-throw inside the
      // makeAsyncResult net so it rides the defect channel, like production.
      // oxlint-disable-next-line unthrown/no-throw -- defect-channel edge: the unmodeled cause must surface as a defect, mirroring the worker boundary
      throw error;
    }

    // Receiving side of the output boundary: the handler validated the
    // implementation's return but transmitted the ORIGINAL value, so the
    // consumer-side parse here applies a transforming output schema exactly
    // once — mirroring the workflow-side proxy. It fails when the value did
    // not survive serialization.
    const outputResult = await definition.output["~standard"].validate(wireOutput);
    if (outputResult.issues) {
      const failure: ApplicationFailure = new ActivityOutputValidationError(
        activityName,
        outputResult.issues,
      );
      return Err(failure as RunActivityHandlerError<TActivity>);
    }
    return Ok(outputResult.value as ClientInferOutput<TActivity>);
  });
}
