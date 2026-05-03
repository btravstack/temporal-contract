/**
 * Internal helpers shared across the client package's modules.
 *
 * Not part of the public API — this module is not listed in the package's
 * `exports` map, so consumers can't import from `@temporal-contract/client/internal`.
 * In-package modules and tests import it directly via relative path.
 */
import { Future, Result } from "@swan-io/boxed";
import { RuntimeClientError } from "./errors.js";

/**
 * Wrap an async result-producing function in a `Future`, catching any
 * unhandled rejection as a `RuntimeClientError("unexpected", error)`.
 *
 * The work function is expected to handle its own domain errors and return
 * a `Result.Error(...)` for them; the catch here is a safety net for
 * thrown exceptions the work didn't anticipate.
 *
 * Used by `client.ts` (workflow operations) and `schedule.ts` (schedule
 * operations) so the unexpected-rejection shape is identical across the
 * typed client surface.
 */
export function makeFuture<T, E>(
  work: () => Promise<Result<T, E>>,
): Future<Result<T, E | RuntimeClientError>> {
  return Future.make((resolve) => {
    work()
      .then(resolve)
      .catch((e: unknown) =>
        resolve(Result.Error<T, E | RuntimeClientError>(new RuntimeClientError("unexpected", e))),
      );
  });
}
