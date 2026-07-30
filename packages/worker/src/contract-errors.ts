import type { ErrorDefinition } from "@temporal-contract/contract";
import {
  CONTRACT_ERROR_WIRE_MARKER,
  type AnyContractError,
} from "@temporal-contract/contract/errors";
/**
 * Worker-side bridge between contract-declared typed errors and Temporal's
 * `ApplicationFailure`.
 *
 * Not part of the public API — this module is not listed in the package's
 * `exports` map. The public surface re-exports what consumers need from
 * `./activity` and `./workflow`.
 */
import { ApplicationFailure } from "@temporalio/common";

import { ContractErrorDataValidationError } from "./errors.js";

/**
 * Convert a {@link ContractError} produced by an implementation into the
 * `ApplicationFailure` Temporal serializes across the boundary:
 *
 * - `type` = the declared error name (drives caller branching and
 *   `retry.nonRetryableErrorTypes`),
 * - `details[0]` = the ORIGINAL data payload. It is validated against the
 *   declared schema (fail early on contract misuse), but the parsed value is
 *   discarded — the consuming side (client / workflow-proxy rehydration)
 *   parses it, so a transforming `data` schema applies exactly once,
 * - `details[1]` = the `CONTRACT_ERROR_WIRE_MARKER` provenance/version
 *   envelope, so the rehydrating side can tell a genuine contract error from
 *   an unrelated `ApplicationFailure` that reuses a declared name as its
 *   `type` (required for data-less errors, corroborating for data-carrying
 *   ones),
 * - `nonRetryable` = the contract's declaration (default retryable),
 * - `cause` = the constructor-supplied cause, so stack traces survive.
 *
 * An undeclared error name or a data payload that fails validation is a
 * deterministic contract-misuse bug — both throw the terminal
 * {@link ContractErrorDataValidationError} instead of letting a malformed
 * failure cross the wire.
 */
export async function contractErrorToApplicationFailure(
  error: AnyContractError,
  declaredErrors: Record<string, ErrorDefinition> | undefined,
  scopeLabel: string,
): Promise<ApplicationFailure> {
  const definition = declaredErrors?.[error.errorName];
  if (!definition) {
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
    throw new ContractErrorDataValidationError(error.errorName, [
      {
        message:
          `Error "${error.errorName}" is not declared on ${scopeLabel}. ` +
          `Declared errors: ${Object.keys(declaredErrors ?? {}).join(", ") || "none"}.`,
      },
    ]);
  }

  // `details[0]` is always the data slot (undefined for data-less errors)
  // and `details[1]` the wire marker, so slot positions stay stable.
  let details: unknown[] = [undefined, CONTRACT_ERROR_WIRE_MARKER];
  if (definition.data) {
    const validated = await definition.data["~standard"].validate(error.data);
    if (validated.issues) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new ContractErrorDataValidationError(error.errorName, validated.issues);
    }
    // Transmit the ORIGINAL payload — the rehydrating side parses it (D1).
    details = [error.data, CONTRACT_ERROR_WIRE_MARKER];
  }

  return ApplicationFailure.create({
    type: error.errorName,
    message: error.message,
    nonRetryable: definition.nonRetryable ?? false,
    details,
    ...(error.cause !== undefined && error.cause instanceof Error ? { cause: error.cause } : {}),
  });
}
