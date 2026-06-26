/**
 * Internal helper shared across `@temporal-contract/client` and
 * `@temporal-contract/worker` for wrapping a result-producing async function
 * in an `AsyncResult`, routing any unanticipated rejection through unthrown's
 * `defect` channel.
 *
 * Lives in `@temporal-contract/contract` so the two consuming packages don't
 * each carry their own copy. Exported from the package's public surface
 * under a deliberately-internal-looking name (`_internal_makeAsyncResult`)
 * so users don't import it by accident — there is no semver guarantee on
 * this entry point.
 */
import { fromSafePromise, type AsyncResult, type Result } from "unthrown";

/**
 * Wrap an async function returning `Promise<Result<T, E>>` in an
 * `AsyncResult<T, E>`, catching synchronous throws and rejected promises and
 * routing them through unthrown's `defect` channel — so an *unanticipated*
 * failure surfaces as a defect (a bug, re-thrown at the edge) rather than an
 * unhandled rejection, while the work function's own domain `err(...)` flows
 * through untouched.
 *
 * `fromSafePromise(thunk)` invokes the thunk, capturing both a synchronous
 * throw before the promise is produced and an eventual rejection as a `defect`
 * (its error channel is `never`) — the work function is expected to model its
 * own domain errors as `err(...)`, so any *thrown* failure is by definition
 * unmodeled. The `.flatMap((inner) => inner)` flattens the nested
 * `Result<T, E>` the thunk resolves with, surfacing its modeled error channel.
 *
 * @internal — exported under `_internal_makeAsyncResult` for use by the
 * sibling client and worker packages. Not part of the public API.
 */
export function _internal_makeAsyncResult<T, E>(
  work: () => Promise<Result<T, E>>,
): AsyncResult<T, E> {
  return fromSafePromise(work).flatMap((inner) => inner);
}
