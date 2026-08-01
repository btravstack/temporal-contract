import { ApplicationFailure } from "@temporalio/workflow";

import { ContractError, declareWorkflow } from "../workflow.js";
import { rehydrationWorkerContract } from "./rehydration.contract.js";

/**
 * Workflow for the rehydration audit-gap specs. Mode-driven:
 *
 * - `"expired"` — throws the workflow-declared typed error with data that is
 *   valid on the worker contract but fails the client's stricter twin
 *   (contract-skew scenario);
 * - `"bad-data"` — throws the workflow-declared typed error with data that
 *   fails ITS OWN (worker-side) schema: `declareWorkflow`'s catch block must
 *   fail fast with `ContractErrorDataValidationError` rather than letting a
 *   malformed failure cross the wire;
 * - `"boom"` — throws a plain `ApplicationFailure` with an undeclared `type`,
 *   built without the typed constructors: `declareWorkflow`'s catch block
 *   must rethrow it untouched (not misclassify it as a contract error, not
 *   swallow it);
 * - anything else — calls the `charge` activity and reports how the
 *   workflow-side proxy classified its failure: `contract:<name>` for a
 *   rehydrated typed error, `generic:<_tag>` for the untyped fallback.
 */
export const quote = declareWorkflow({
  workflowName: "quote",
  contract: rehydrationWorkerContract,
  // No `activityOptions`: the only activity carries contract-level options.
  implementation: async (context, args) => {
    if (args.mode === "expired") {
      // Valid against the worker contract's schema; the client's stricter
      // schema rejects it on rehydration.
      throw context.errors.QuoteExpired({ quoteId: "legacy-1" });
    }

    if (args.mode === "bad-data") {
      // Deliberately invalid payload — the typed constructor defers
      // validation to the Temporal boundary, so this constructs fine; the
      // boundary conversion inside `declareWorkflow` must reject it before
      // it crosses the wire.
      throw context.errors.QuoteExpired({ quoteId: 42 } as never);
    }

    if (args.mode === "boom") {
      // Not a ContractError — `declareWorkflow`'s catch block must let this
      // through unmodified.
      throw ApplicationFailure.create({
        type: "SOMETHING_ELSE",
        message: "boom",
        nonRetryable: true,
      });
    }

    const result = await context.activities.charge({ mode: args.mode });
    if (result.isDefect()) {
      // An unmodeled bug — rethrow the original cause at the edge.
      // oxlint-disable-next-line unthrown/no-throw -- defect-cause rethrow at the edge: an unmodeled failure must surface as a Workflow Task failure
      throw result.cause;
    }
    if (result.isErr()) {
      const classification =
        result.error instanceof ContractError
          ? `contract:${result.error.errorName}`
          : `generic:${result.error._tag}`;
      return { classification };
    }
    return { classification: "ok" };
  },
});
