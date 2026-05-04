/**
 * Internal helper shared across `@temporal-contract/client` and
 * `@temporal-contract/worker` for wrapping a result-producing async function
 * in a `ResultAsync` while routing any unhandled rejection through a typed
 * mapper.
 *
 * Lives in `@temporal-contract/contract` so the two consuming packages don't
 * each carry their own copy. Exported from the package's public surface
 * under a deliberately-internal-looking name (`_internal_makeResultAsync`)
 * so users don't import it by accident — there is no semver guarantee on
 * this entry point.
 */
import { ResultAsync, type Result, err } from "neverthrow";

/**
 * Wrap an async function returning `Promise<Result<T, E>>` in a
 * `ResultAsync<T, E>`, catching synchronous throws and rejected promises
 * and routing them through `mapRejection` so they surface as typed
 * `err(...)` instead of unhandled rejections.
 *
 * `new ResultAsync(promise)` does **not** catch rejections — the resulting
 * `ResultAsync` rejects, escaping neverthrow's railway. This helper closes
 * that gap. The work function is expected to handle its own domain errors
 * and return `err(...)` for them; `mapRejection` is a safety net for
 * thrown exceptions the work didn't anticipate.
 *
 * @internal — exported under `_internal_makeResultAsync` for use by the
 * sibling client and worker packages. Not part of the public API.
 */
export function _internal_makeResultAsync<T, E>(
  work: () => Promise<Result<T, E>>,
  mapRejection: (error: unknown) => E,
): ResultAsync<T, E> {
  let promise: Promise<Result<T, E>>;
  try {
    promise = work();
  } catch (error) {
    // Synchronous throw before the function returned its promise. Without
    // this branch, `work()` blowing up synchronously would surface as a
    // thrown error from the constructor call rather than an `err(...)`.
    promise = Promise.resolve(err(mapRejection(error)));
  }
  return new ResultAsync<T, E>(promise.catch((e: unknown) => err(mapRejection(e))));
}
