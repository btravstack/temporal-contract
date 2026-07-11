/**
 * Worker-side bridge between contract-declared typed errors and Temporal's
 * `ApplicationFailure`.
 *
 * Not part of the public API — this module is not listed in the package's
 * `exports` map. The public surface re-exports what consumers need from
 * `./activity` and `./workflow`.
 */
import { ApplicationFailure } from "@temporalio/common";
import type { ErrorDefinition } from "@temporal-contract/contract";
import type { AnyContractError } from "@temporal-contract/contract/errors";
import { ContractErrorDataValidationError } from "./errors.js";

/**
 * Convert a {@link ContractError} produced by an implementation into the
 * `ApplicationFailure` Temporal serializes across the boundary:
 *
 * - `type` = the declared error name (drives caller branching and
 *   `retry.nonRetryableErrorTypes`),
 * - `details[0]` = the data payload, validated against the declared schema,
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
      throw new ContractErrorDataValidationError(error.errorName, validated.issues);
    }
    details = [validated.value];
  }

  return ApplicationFailure.create({
    type: error.errorName,
    message: error.message,
    nonRetryable: definition.nonRetryable ?? false,
    details,
    ...(error.cause !== undefined && error.cause instanceof Error ? { cause: error.cause } : {}),
  });
}
