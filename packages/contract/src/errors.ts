/**
 * Public entry point `@temporal-contract/contract/errors` — the typed
 * domain-error surface (classes, types, and the rehydration-miss diagnostic
 * hook).
 *
 * Lives in its own entry point rather than the package root because the
 * implementation imports `unthrown` at runtime — the root entry must stay
 * importable without the optional `unthrown` peer installed (defining a
 * contract needs no Result machinery).
 *
 * The `_internal_*` helpers backing the sibling worker/client/testing
 * packages are deliberately NOT re-exported here — they live on the
 * `@temporal-contract/contract/internal` entry point, which carries no
 * semver guarantee.
 */
export { CONTRACT_ERROR_TAG, TECHNICAL_ERROR_TAG } from "./error-tags.js";
export {
  type AnyContractError,
  type ApplicationFailureLike,
  CONTRACT_ERROR_WIRE_MARKER,
  ContractError,
  type ContractErrorConstructors,
  type ContractErrorInputUnion,
  type ContractErrorOptions,
  type ContractErrorUnion,
  onRehydrationMiss,
  type RehydrationMiss,
  TechnicalError,
} from "./errors-impl.js";
