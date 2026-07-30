/**
 * Named constants for the unthrown `_tag` literals of this package's tagged
 * errors, so consumers can match without hand-writing the namespaced strings:
 *
 * ```ts
 * result.mapErrCases((matcher) =>
 *   matcher.with(P.tag(CONTRACT_ERROR_TAG), (e) => e.errorName),
 * );
 * ```
 *
 * Kept in a standalone, dependency-free module (no `unthrown` import) so the
 * constants are re-exportable from the package root, which must stay
 * importable without the optional `unthrown` peer installed.
 */

/** `_tag` of `ContractError` — a contract-declared typed domain error. */
export const CONTRACT_ERROR_TAG = "@temporal-contract/ContractError";

/** `_tag` of `TechnicalError` — an infrastructure fault carried as a defect's `cause`. */
export const TECHNICAL_ERROR_TAG = "@temporal-contract/TechnicalError";
