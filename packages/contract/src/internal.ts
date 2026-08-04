/**
 * Internal entry point `@temporal-contract/contract/internal` — helpers
 * shared across the sibling `@temporal-contract/client`,
 * `@temporal-contract/worker`, and `@temporal-contract/testing` packages.
 *
 * They live in `@temporal-contract/contract` so the consuming packages don't
 * each carry their own copy. **Not part of the public API** — the dedicated
 * `./internal` subpath and the `_internal_` name prefixes both signal that
 * there is no semver guarantee on anything exported here.
 */
import {
  fromSafePromise,
  type AsyncResult,
  type ErrView,
  type OkView,
  type Result,
} from "unthrown";

export {
  _internal_buildErrorConstructors,
  _internal_rehydrateContractError,
} from "./errors-impl.js";

/**
 * Mode→policy mapping for `idempotency` — re-exported under the
 * `_internal_` prefix used throughout this subpath. Not part of the public
 * API: contract authors only ever set `idempotency` on `defineWorkflow`; the
 * client and worker are the ones that translate it to Temporal's
 * `workflowIdReusePolicy` via this function, so it lives here rather than on
 * `.` alongside the public `IdempotencyMode` type.
 */
export { reusePolicyFor as _internal_reusePolicyFor } from "./idempotency.js";

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
 * @internal — exported on the `./internal` subpath for use by the sibling
 * client and worker packages. Not part of the public API.
 */
export function _internal_makeAsyncResult<T, E>(
  // oxlint-disable-next-line unthrown/prefer-async-result -- this IS the Promise→AsyncResult conversion seam: the work thunk's throw/rejection is what becomes the defect, and an async implementer cannot be annotated AsyncResult
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
 * @internal — exported on the `./internal` subpath for the sibling client
 * and worker packages. Not part of the public API.
 */
export function _internal_assertNoDefect<T, E>(
  result: Result<T, E>,
): asserts result is OkView<T, E> | ErrView<E, T> {
  if (result.isDefect()) {
    // oxlint-disable-next-line unthrown/no-throw -- defect-cause rethrow at the boundary: a genuine bug must keep riding the defect channel
    throw result.cause;
  }
}
