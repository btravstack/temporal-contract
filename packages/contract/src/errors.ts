/**
 * Runtime support for contract-declared typed domain errors.
 *
 * Lives in its own entry point (`@temporal-contract/contract/errors`) rather
 * than the package root because it imports `unthrown` at runtime — the root
 * entry must stay importable without the optional `unthrown` peer installed
 * (defining a contract needs no Result machinery). Same pattern as
 * `./result-async`.
 *
 * The worker and client packages both build on this module:
 * - the worker hands implementations typed **constructors** for the errors
 *   declared on their activity/workflow, and converts a returned/thrown
 *   {@link ContractError} into a Temporal `ApplicationFailure`
 *   (`type` = error name, `details[0]` = validated data, `nonRetryable`
 *   from the contract) at the boundary;
 * - the workflow-side activities proxy and the client **rehydrate** a
 *   matching `ApplicationFailure` back into a {@link ContractError}, so
 *   consumers branch on a typed, schema-validated error union instead of
 *   string-matching failure types.
 */
import { TaggedError } from "unthrown";

import type { AnySchema, ErrorDefinition, InferErrorData, InferErrorDataInput } from "./types.js";

/**
 * Error for technical/runtime failures that cannot be prevented by
 * TypeScript — connection failures, missing runtime capabilities, worker
 * bundling errors. Surfaced on the `Err` channel of the creation factories
 * (`TypedClient.create`, `createWorker`), never thrown: it is a *modeled*
 * error (it lives in the `E` channel of a `Result`), not a `Defect`.
 *
 * Mirrors amqp-contract's `TechnicalError` — the org-wide shape for
 * `Typed*.create()` factories returning `AsyncResult<_, TechnicalError>`.
 */
export class TechnicalError extends TaggedError("@temporal-contract/TechnicalError", {
  name: "TechnicalError",
})<{
  cause?: unknown;
}> {
  constructor(message: string, cause?: unknown) {
    super({ cause });
    this.message = message;
  }
}

/**
 * A typed domain error declared on a contract's `errors` map.
 *
 * One class covers every declared error; the `errorName` field is the
 * per-error discriminant (it equals the key in the contract's `errors` map
 * and the `ApplicationFailure.type` on the wire). Narrow a union with it:
 *
 * ```ts
 * if (result.isErr() && result.error instanceof ContractError) {
 *   switch (result.error.errorName) {
 *     case "PaymentDeclined":
 *       result.error.data; // { reason: string }
 *   }
 * }
 * ```
 *
 * The unthrown `_tag` ("@temporal-contract/ContractError") discriminates a
 * `ContractError` from the other tagged errors in a Result's error channel
 * (e.g. via `result.match({ errCases: (m) => m.with(tag("@temporal-contract/ContractError"), …) })`);
 * `errorName` then narrows to the concrete declared error.
 */
export class ContractError<TName extends string = string, TData = unknown> extends TaggedError(
  "@temporal-contract/ContractError",
  { name: "ContractError" },
)<{
  /** Declared error name — the `ApplicationFailure.type` discriminator. */
  errorName: TName;
  /** Structured payload validated against the declared `data` schema. */
  data: TData;
  cause?: unknown;
}> {
  // unthrown 4 reserves `message` (and `name`) in the TaggedError payload;
  // accept it as a constructor argument and assign it post-`super` instead.
  constructor(args: { errorName: TName; data: TData; message: string; cause?: unknown }) {
    const { message, ...payload } = args;
    super(payload);
    this.message = message;
  }
}

/**
 * Widest `ContractError` instantiation — useful as a constraint or for
 * `instanceof`-style narrowing before discriminating on `errorName`.
 */
export type AnyContractError = ContractError<string, unknown>;

/**
 * Per-instance options accepted by a typed error constructor. The
 * `nonRetryable` flag is deliberately absent: retry semantics live on the
 * contract's {@link ErrorDefinition}, not the call site.
 */
export type ContractErrorOptions = {
  readonly message?: string;
  readonly cause?: unknown;
};

/**
 * Consumer-side union of {@link ContractError} instances for a declared
 * `errors` map — `data` is typed with each schema's *output* (post-transform)
 * shape. This is the union surfaced on the error channel of workflow-side
 * activity calls and client-side workflow results.
 */
export type ContractErrorUnion<TErrors extends Record<string, ErrorDefinition>> = {
  [K in keyof TErrors & string]: ContractError<K, InferErrorData<TErrors[K]>>;
}[keyof TErrors & string];

/**
 * Producer-side union of {@link ContractError} instances for a declared
 * `errors` map — `data` is typed with each schema's *input* (pre-transform)
 * shape, matching what the typed constructors build.
 */
export type ContractErrorInputUnion<TErrors extends Record<string, ErrorDefinition>> = {
  [K in keyof TErrors & string]: ContractError<K, InferErrorDataInput<TErrors[K]>>;
}[keyof TErrors & string];

/**
 * Map of typed error constructors for a declared `errors` map, handed to
 * implementations (activity helpers / workflow context). Errors with a
 * `data` schema take the payload first; data-less errors take only options.
 */
export type ContractErrorConstructors<TErrors extends Record<string, ErrorDefinition>> = {
  [K in keyof TErrors & string]: TErrors[K] extends { data: AnySchema }
    ? (
        data: InferErrorDataInput<TErrors[K]>,
        options?: ContractErrorOptions,
      ) => ContractError<K, InferErrorDataInput<TErrors[K]>>
    : (options?: ContractErrorOptions) => ContractError<K, undefined>;
};

/**
 * Build the runtime constructor map for a declared `errors` record. Each
 * constructor is a thin factory — data validation happens later, at the
 * Temporal boundary, where async Standard Schema validation is possible.
 *
 * @internal — exported under a deliberately-internal-looking name for the
 * sibling worker package. Not part of the public API; no semver guarantee.
 */
export function _internal_buildErrorConstructors(
  declaredErrors: Record<string, ErrorDefinition> | undefined,
): Record<string, (...args: unknown[]) => AnyContractError> {
  const constructors: Record<string, (...args: unknown[]) => AnyContractError> = {};
  if (!declaredErrors) return constructors;

  for (const [errorName, definition] of Object.entries(declaredErrors)) {
    // The declared shape decides the runtime signature: with a `data`
    // schema the first argument is the payload, otherwise it's the options
    // bag. This mirrors the compile-time `ContractErrorConstructors` split.
    constructors[errorName] = definition.data
      ? (data?: unknown, options?: unknown) => {
          const opts = (options ?? {}) as ContractErrorOptions;
          return new ContractError({
            errorName,
            data,
            message: opts.message ?? definition.message ?? `Contract error "${errorName}"`,
            ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
          });
        }
      : (options?: unknown) => {
          const opts = (options ?? {}) as ContractErrorOptions;
          return new ContractError({
            errorName,
            data: undefined,
            message: opts.message ?? definition.message ?? `Contract error "${errorName}"`,
            ...(opts.cause !== undefined ? { cause: opts.cause } : {}),
          });
        };
  }

  return Object.freeze(constructors);
}

/**
 * Structural view of a Temporal `ApplicationFailure` — the fields the
 * rehydrator reads. Kept structural so this package doesn't depend on
 * `@temporalio/common`; callers perform the `instanceof ApplicationFailure`
 * check on their side and pass the instance in.
 */
export type ApplicationFailureLike = {
  readonly type?: string | undefined | null;
  readonly message?: string | undefined;
  readonly details?: readonly unknown[] | null | undefined;
};

/**
 * Attempt to rehydrate an `ApplicationFailure` back into a typed
 * {@link ContractError}, by matching `failure.type` against the declared
 * error names and validating `failure.details[0]` against the declared
 * `data` schema.
 *
 * Returns `undefined` when the failure doesn't correspond to a declared
 * error (unknown `type`, or payload that no longer validates) — callers fall
 * through to their generic failure classification, so a mismatch degrades to
 * today's untyped behavior instead of producing a wrong typed error.
 *
 * @internal — exported under a deliberately-internal-looking name for the
 * sibling worker and client packages. Not part of the public API; no semver
 * guarantee.
 */
export async function _internal_rehydrateContractError(
  declaredErrors: Record<string, ErrorDefinition> | undefined,
  failure: ApplicationFailureLike,
): Promise<AnyContractError | undefined> {
  if (!declaredErrors || !failure.type) return undefined;

  const definition = declaredErrors[failure.type];
  if (!definition) return undefined;

  let data: unknown = undefined;
  if (definition.data) {
    const validated = await definition.data["~standard"].validate(failure.details?.[0]);
    if (validated.issues) return undefined;
    data = validated.value;
  }

  return new ContractError({
    errorName: failure.type,
    data,
    message: failure.message ?? definition.message ?? `Contract error "${failure.type}"`,
    cause: failure,
  });
}
