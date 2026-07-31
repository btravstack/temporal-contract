/**
 * Client-side interceptors — the trace-propagation / retry / observability
 * seam of the typed client, mirroring amqp-contract's
 * `publishInterceptors` / `callInterceptors`.
 *
 * Interceptors wrap a client operation *outside* the contract validation
 * pipeline: a patched input is validated exactly like the caller's original,
 * so an interceptor cannot smuggle unvalidated data past the boundary.
 *
 * Semantics (first entry is the outermost):
 * - **observe** — call `next()` and inspect the returned `AsyncResult`
 *   (`tapErrCases`, `map`, …);
 * - **patch args** — `next({ input: ... })` shallow-merges the patch over the
 *   current invocation before it reaches validation;
 * - **retry** — call `next` again, e.g. from a `recoverDefect` branch for
 *   transient technical faults;
 * - **short-circuit** — return your own `AsyncResult` without calling `next`.
 */
import type { AnyContractError } from "@temporal-contract/contract/errors";
import type { AsyncResult } from "unthrown";

import type {
  QueryFailedError,
  QueryValidationError,
  SignalValidationError,
  UpdateFailedError,
  UpdateRejectedError,
  UpdateValidationError,
  WorkflowAlreadyStartedError,
  WorkflowCancelledError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
  WorkflowNotInContractError,
  WorkflowTerminatedError,
  WorkflowTimeoutError,
  WorkflowValidationError,
} from "./errors.js";

/**
 * Union of every modeled error a typed-client operation can surface. The
 * interceptor chain is typed against this widened union; each public method
 * narrows it back to its precise union at the boundary (types are erased
 * through the chain and restored at the edge — same approach as
 * amqp-contract's `call()`).
 */
export type ClientCallError =
  | WorkflowNotInContractError
  | WorkflowValidationError
  | WorkflowAlreadyStartedError
  | WorkflowFailedError
  | WorkflowCancelledError
  | WorkflowTerminatedError
  | WorkflowTimeoutError
  | WorkflowExecutionNotFoundError
  | SignalValidationError
  | QueryValidationError
  | QueryFailedError
  | UpdateValidationError
  | UpdateFailedError
  | UpdateRejectedError
  | AnyContractError;

/**
 * Invocation description handed to every interceptor — a discriminated
 * union over the wrapped operations.
 */
export type ClientInterceptorArgs =
  | {
      /** Workflow-lifecycle operations. */
      readonly operation: "startWorkflow" | "executeWorkflow";
      readonly workflowName: string;
      readonly workflowId: string;
      /** The (not yet validated) workflow input. */
      readonly input: unknown;
    }
  | {
      readonly operation: "signalWithStart";
      readonly workflowName: string;
      readonly workflowId: string;
      /** The (not yet validated) workflow input. */
      readonly input: unknown;
      readonly signalName: string;
      /** The (not yet validated) signal input. */
      readonly signalInput: unknown;
    }
  | {
      /** Handle-level interactions with a running workflow. */
      readonly operation: "signal" | "query" | "update";
      readonly workflowName: string;
      readonly workflowId: string;
      /** The signal / query / update name on the contract. */
      readonly name: string;
      /** The (not yet validated) payload. */
      readonly input: unknown;
    };

/**
 * Continuation invoked by a {@link ClientInterceptor}. An optional patch is
 * shallow-merged over the current invocation (`input`, and `signalInput` for
 * `signalWithStart`) before the next stage runs.
 */
export type ClientInterceptorNext = (patch?: {
  readonly input?: unknown;
  readonly signalInput?: unknown;
}) => AsyncResult<unknown, ClientCallError>;

/**
 * A client-side interceptor. See the module doc for semantics; the array
 * passed to `TypedClient.create` composes outermost-first.
 *
 * @example Retry a transient (technical) failure once
 * ```ts
 * import { RuntimeClientError } from "@temporal-contract/client";
 *
 * // Transient technical faults — a connection blip, a gRPC hiccup — ride the
 * // Defect channel, so retry them with `recoverDefect`; re-raise anything else
 * // as a defect so it still surfaces at the edge.
 * const retryOnce: ClientInterceptor = (args, next) =>
 *   next().recoverDefect((cause) => {
 *     if (cause instanceof RuntimeClientError) return next();
 *     throw cause; // not a transient fault we own — keep it a defect
 *   });
 * ```
 *
 * Modeled domain errors (`WorkflowNotInContractError`, a `ContractError`, …) stay on
 * the `Err` channel — branch on those with `flatMapErrCases` / `match` as usual;
 * `recoverDefect` / `tapDefect` are for the technical faults on the defect channel.
 */
export type ClientInterceptor = (
  args: ClientInterceptorArgs,
  next: ClientInterceptorNext,
) => AsyncResult<unknown, ClientCallError>;

/**
 * The keys of a patch an interceptor is allowed to change — the two payload
 * fields. Identity fields (`operation`, `workflowName`, `workflowId`,
 * `name`) describe *which* call is in flight and are owned by the call site;
 * an interceptor observing or patching a call must not be able to relabel
 * it mid-chain.
 */
type InterceptorPatch = {
  readonly input?: unknown;
  readonly signalInput?: unknown;
};

/**
 * Merge ONLY the payload keys of a patch over the current invocation. A key
 * is copied when the patch *carries* it (`"input" in patch`), so patching
 * `input: undefined` still overwrites — while any non-payload key an
 * interceptor smuggles into the patch object is dropped.
 */
function mergePatch<TArgs extends object>(current: TArgs, patch: InterceptorPatch): TArgs {
  const merged = { ...current };
  if ("input" in patch) {
    (merged as { input?: unknown }).input = patch.input;
  }
  if ("signalInput" in patch) {
    (merged as { signalInput?: unknown }).signalInput = patch.signalInput;
  }
  return merged;
}

/**
 * Run `terminal` through a chain of interceptors, outermost-first. Each
 * interceptor's `next(patch)` merges the patch's payload keys (`input`,
 * `signalInput` — and only those; identity fields like `workflowName`
 * cannot be rewritten) over the current args and advances; calling `next`
 * again re-runs the rest of the chain (retry).
 *
 * Ported from amqp-contract's `chainInterceptors`.
 *
 * @internal
 */
export function chainInterceptors<
  TArgs extends object,
  TPatch extends InterceptorPatch,
  TValue,
  TError,
>(
  interceptors: readonly ((
    args: TArgs,
    next: (patch?: TPatch) => AsyncResult<TValue, TError>,
  ) => AsyncResult<TValue, TError>)[],
  args: TArgs,
  terminal: (args: TArgs) => AsyncResult<TValue, TError>,
): AsyncResult<TValue, TError> {
  const run = (index: number, current: TArgs): AsyncResult<TValue, TError> =>
    index >= interceptors.length
      ? terminal(current)
      : interceptors[index]!(current, (patch) =>
          run(index + 1, patch === undefined ? current : mergePatch(current, patch)),
        );
  return run(0, args);
}
