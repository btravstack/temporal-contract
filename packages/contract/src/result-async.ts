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
import {
  fromSafePromise,
  type AsyncResult,
  type ErrView,
  type OkView,
  type Result,
} from "unthrown";

/**
 * Wrap an async function returning `Promise<Result<T, E>>` in an
 * `AsyncResult<T, E>`, catching synchronous throws and rejected promises and
 * routing them through unthrown's `defect` channel — so an *unanticipated*
 * failure surfaces as a defect (a bug, re-thrown at the edge) rather than an
 * unhandled rejection, while the work function's own domain `Err(...)` flows
 * through untouched.
 *
 * `fromSafePromise(thunk)` invokes the thunk, capturing both a synchronous
 * throw before the promise is produced and an eventual rejection as a `defect`
 * (its error channel is `never`) — the work function is expected to model its
 * own domain errors as `Err(...)`, so any *thrown* failure is by definition
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

/**
 * Assert that a `Result` is not a `Defect`, narrowing it to `Ok | Err`.
 *
 * unthrown's `Result<T, E>` type always includes the out-of-band `Defect`
 * variant, so `if (r.isErr()) … else r.value` does not type-check — the `else`
 * branch is still `Ok | Defect`. For an internally-produced result that is
 * *known* to be built only from `Ok(...)` / `Err(...)`, this collapses the
 * "impossible defect" case in one call: it re-throws a present defect's cause
 * (so a genuine bug still rides the defect channel at the boundary) and
 * narrows the result to `Ok | Err` for the caller, which can then branch on
 * `isErr` / `isOk` and reach `.value` / `.error` cleanly.
 *
 * @internal — exported under `_internal_assertNoDefect` for the sibling client
 * and worker packages. Not part of the public API.
 */
export function _internal_assertNoDefect<T, E>(
  result: Result<T, E>,
): asserts result is OkView<T, E> | ErrView<E, T> {
  if (result.isDefect()) {
    throw result.cause;
  }
}
