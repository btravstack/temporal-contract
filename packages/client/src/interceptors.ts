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
 *   (`tapErr`, `map`, …);
 * - **patch args** — `next({ input: ... })` shallow-merges the patch over the
 *   current invocation before it reaches validation;
 * - **retry** — call `next` again from a `flatMapErr` branch;
 * - **short-circuit** — return your own `AsyncResult` without calling `next`.
 */
import type { AsyncResult } from "unthrown";
import type { AnyContractError } from "@temporal-contract/contract/errors";
import type {
  QueryValidationError,
  RuntimeClientError,
  SignalValidationError,
  UpdateValidationError,
  WorkflowAlreadyStartedError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
  WorkflowNotFoundError,
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
  | WorkflowNotFoundError
  | WorkflowValidationError
  | WorkflowAlreadyStartedError
  | WorkflowFailedError
  | WorkflowExecutionNotFoundError
  | SignalValidationError
  | QueryValidationError
  | UpdateValidationError
  | RuntimeClientError
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
 * @example Retry a transient failure once
 * ```ts
 * const retryOnce: ClientInterceptor = (args, next) =>
 *   next().flatMapErr((error) =>
 *     error instanceof RuntimeClientError ? next() : Err(error).toAsync(),
 *   );
 * ```
 */
export type ClientInterceptor = (
  args: ClientInterceptorArgs,
  next: ClientInterceptorNext,
) => AsyncResult<unknown, ClientCallError>;

/**
 * Run `terminal` through a chain of interceptors, outermost-first. Each
 * interceptor's `next(patch)` shallow-merges the patch over the current args
 * and advances; calling `next` again re-runs the rest of the chain (retry).
 *
 * Ported from amqp-contract's `chainInterceptors`.
 *
 * @internal
 */
export function chainInterceptors<TArgs extends object, TPatch extends object, TValue, TError>(
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
      : interceptors[index]!(current, (patch) => run(index + 1, { ...current, ...patch }));
  return run(0, args);
}
