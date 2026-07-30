import type { ErrorDefinition } from "@temporal-contract/contract";
import type { AnyContractError } from "@temporal-contract/contract/errors";
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

  let details: unknown[] = [];
  if (definition.data) {
    const validated = await definition.data["~standard"].validate(error.data);
    if (validated.issues) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new ContractErrorDataValidationError(error.errorName, validated.issues);
    }
    // Transmit the ORIGINAL payload — the rehydrating side parses it (D1).
    details = [error.data];
  }

  return ApplicationFailure.create({
    type: error.errorName,
    message: error.message,
    nonRetryable: definition.nonRetryable ?? false,
    details,
    ...(error.cause !== undefined && error.cause instanceof Error ? { cause: error.cause } : {}),
  });
}
