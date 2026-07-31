/**
 * Runtime support for contract-declared typed domain errors.
 *
 * Implementation module behind two entry points: the public surface is
 * re-exported from `./errors.ts` (`@temporal-contract/contract/errors`) and
 * the `_internal_*` helpers from `./internal.ts`
 * (`@temporal-contract/contract/internal`). It lives outside the package
 * root because it imports `unthrown` at runtime — the root entry must stay
 * importable without the optional `unthrown` peer installed (defining a
 * contract needs no Result machinery).
 *
 * The worker and client packages both build on this module:
 * - the worker hands implementations typed **constructors** for the errors
 *   declared on their activity/workflow, and converts a returned/thrown
 *   {@link ContractError} into a Temporal `ApplicationFailure`
 *   (`type` = error name, `details[0]` = validated data, `details[1]` =
 *   the {@link CONTRACT_ERROR_WIRE_MARKER} envelope marker, `nonRetryable`
 *   from the contract) at the boundary;
 * - the workflow-side activities proxy and the client **rehydrate** a
 *   matching `ApplicationFailure` back into a {@link ContractError}, so
 *   consumers branch on a typed, schema-validated error union instead of
 *   string-matching failure types.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { TaggedError } from "unthrown";

import { CONTRACT_ERROR_TAG, TECHNICAL_ERROR_TAG } from "./error-tags.js";
import type { AnySchema, ErrorDefinition, InferErrorData, InferErrorDataInput } from "./types.js";

export { CONTRACT_ERROR_TAG, TECHNICAL_ERROR_TAG } from "./error-tags.js";

/**
 * Error for technical/runtime failures that cannot be prevented by
 * TypeScript — connection failures, missing runtime capabilities, worker
 * bundling errors. These are *unmodeled* infrastructure faults, never
 * anticipated domain failures, so they ride the `Defect` channel: the
 * creation factories (`TypedClient.create`, `TypedWorker.create`) surface them as a
 * `Defect` whose `cause` is a `TechnicalError` instance (inspect via `match`'s
 * `defect` handler, `recoverDefect`, or `tapDefect`) — this class never
 * appears in a `Result`'s modeled `E` channel.
 *
 * The class is retained (and still exported) so the descriptive message and
 * `cause` survive for logging; it is only ever used as a defect's `cause`.
 */
export class TechnicalError extends TaggedError(TECHNICAL_ERROR_TAG, {
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
 * (e.g. via `result.match({ errCases: (m) => m.with(P.tag("@temporal-contract/ContractError"), …) })`);
 * `errorName` then narrows to the concrete declared error.
 */
export class ContractError<TName extends string = string, TData = unknown> extends TaggedError(
  CONTRACT_ERROR_TAG,
  { name: "ContractError" },
)<{
  /** Declared error name — the `ApplicationFailure.type` discriminator. */
  errorName: TName;
  /** Structured payload validated against the declared `data` schema. */
  data: TData;
  cause?: unknown;
}> {
  // unthrown 5 reserves `name`, `message`, and `stack` in the TaggedError
  // payload; accept `message` as a constructor argument and assign it
  // post-`super` instead.
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
 * @internal — exported on the `./internal` subpath for the sibling worker
 * package. Not part of the public API; no semver guarantee.
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
 * Wire-envelope marker carried at `details[1]` of every `ApplicationFailure`
 * produced from a {@link ContractError} (`details[0]` stays the data
 * payload). It marks the failure as temporal-contract provenance, versioned
 * for future envelope evolution, so the rehydrator can tell a genuine
 * contract error from an unrelated `ApplicationFailure` that merely reuses a
 * declared error name as its `type` string.
 */
export const CONTRACT_ERROR_WIRE_MARKER = { $tc: 1 } as const;

/** Does the failure's `details` carry the {@link CONTRACT_ERROR_WIRE_MARKER}? */
function hasWireMarker(details: readonly unknown[] | null | undefined): boolean {
  const candidate = details?.[1];
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate as Record<string, unknown>)["$tc"] === CONTRACT_ERROR_WIRE_MARKER.$tc
  );
}

/**
 * Diagnostic payload describing a rehydration miss: a failure whose `type`
 * matched a declared error name but that could not be rehydrated as the
 * typed {@link ContractError} and degraded to the caller's generic failure
 * classification.
 */
export type RehydrationMiss = {
  /** The declared error name that `failure.type` matched. */
  readonly errorName: string;
  /**
   * Why rehydration degraded:
   * - `"data-validation-failed"` — the declared `data` schema rejected
   *   `details[0]` (schema drift or a foreign failure with a payload);
   * - `"missing-wire-marker"` — a data-less declared error without the
   *   {@link CONTRACT_ERROR_WIRE_MARKER}, i.e. most likely an unrelated
   *   `ApplicationFailure` reusing the declared name as its `type`.
   */
  readonly reason: "data-validation-failed" | "missing-wire-marker";
  /** Validation issues when `reason` is `"data-validation-failed"`. */
  readonly issues?: ReadonlyArray<StandardSchemaV1.Issue>;
  /** The failure that was being rehydrated. */
  readonly failure: ApplicationFailureLike;
};

let rehydrationMissHandler: ((miss: RehydrationMiss) => void) | undefined;

/**
 * Register a module-level diagnostic hook invoked whenever a failure whose
 * `type` matches a declared error name fails to rehydrate as a typed
 * {@link ContractError} (see {@link RehydrationMiss}). The degrade-to-generic
 * behavior is unchanged — this only makes it observable. The worker and
 * client packages wire this into their loggers; pass `undefined` to
 * unregister. A throwing handler is swallowed: diagnostics must never break
 * error classification.
 */
export function onRehydrationMiss(handler: ((miss: RehydrationMiss) => void) | undefined): void {
  rehydrationMissHandler = handler;
}

function reportRehydrationMiss(miss: RehydrationMiss): void {
  if (!rehydrationMissHandler) return;
  try {
    rehydrationMissHandler(miss);
  } catch {
    // Deliberately swallowed — a throwing diagnostic hook must not turn a
    // degrade-to-generic path into a hard failure.
  }
}

/**
 * Attempt to rehydrate an `ApplicationFailure` back into a typed
 * {@link ContractError}, by matching `failure.type` against the declared
 * error names and validating `failure.details[0]` against the declared
 * `data` schema.
 *
 * Provenance rules:
 * - errors **with** a `data` schema: schema validation is the gate — the
 *   {@link CONTRACT_ERROR_WIRE_MARKER} at `details[1]` is preferred but not
 *   required (a validating payload is strong-enough evidence);
 * - errors **without** a `data` schema: the marker is **required** —
 *   otherwise any unrelated `ApplicationFailure` whose `type` happens to
 *   equal a declared data-less error name would be surfaced as the typed
 *   domain error.
 *
 * Returns `undefined` when the failure doesn't correspond to a declared
 * error (unknown `type`, payload that no longer validates, or a data-less
 * name without the marker) — callers fall through to their generic failure
 * classification, so a mismatch degrades to today's untyped behavior instead
 * of producing a wrong typed error. Degrades are reported through the
 * {@link onRehydrationMiss} hook so they are observable.
 *
 * @internal — exported on the `./internal` subpath for the sibling worker
 * and client packages. Not part of the public API; no semver guarantee.
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
    if (validated.issues) {
      reportRehydrationMiss({
        errorName: failure.type,
        reason: "data-validation-failed",
        issues: validated.issues,
        failure,
      });
      return undefined;
    }
    data = validated.value;
  } else if (!hasWireMarker(failure.details)) {
    reportRehydrationMiss({
      errorName: failure.type,
      reason: "missing-wire-marker",
      failure,
    });
    return undefined;
  }

  return new ContractError({
    errorName: failure.type,
    data,
    message: failure.message ?? definition.message ?? `Contract error "${failure.type}"`,
    cause: failure,
  });
}
