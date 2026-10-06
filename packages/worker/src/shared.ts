/**
 * Internal helpers shared by the activity and workflow entry points. Must not
 * import `@temporalio/workflow`: the `./activity` entry runs outside the
 * sandbox and should not load it (workflow-only helpers live in
 * `internal.ts`).
 *
 * Not part of the public API — not listed in the package's `exports` map.
 */

// Re-export the shared `_internal_makeAsyncResult` helper from the contract
// package so worker call sites can wrap their `() => Promise<Result<T, E>>`
// work functions identically to the client side. Unanticipated rejections
// (a synchronous throw or a rejected promise from `work()`) are routed through
// unthrown's `defect` channel rather than escaping as an unhandled rejection.
// `assertNoDefect` narrows an internally-built `Result` (known to carry only
// ok/err) to `Ok | Err`, re-throwing a stray defect's cause — so call sites
// reach `.value` / `.error` without a manual "impossible defect" guard.
export {
  _internal_makeAsyncResult as makeAsyncResult,
  _internal_assertNoDefect as assertNoDefect,
} from "@temporal-contract/contract/internal";

/**
 * Extract the single payload from a Temporal handler's `...args` array.
 *
 * Temporal invokes handlers with whatever was passed via `args: [...]` at the
 * call site. The typed-contract layer always sends `args: [input]` — the
 * caller's original (validated but untransformed) value, which the receiving
 * handler parses — so the common case is a one-element array containing the
 * wrapped input.
 *
 * Zero arguments map to `undefined`, not `[]`: a payload-less send (e.g. a
 * signal declared without an `input` schema, whose materialized
 * `UndefinedInputSchema` only accepts `undefined`/`null`) must parse as "no
 * payload", and an empty array would be rejected by that schema.
 *
 * If a non-typed-contract caller passes multiple positional arguments
 * (`args: [a, b, c]`), we surface the whole array as the input — the schema
 * will then reject it unless the contract specifically modeled a tuple.
 */
export function extractHandlerInput(args: unknown[]): unknown {
  if (args.length === 0) return undefined;
  return args.length === 1 ? args[0] : args;
}
