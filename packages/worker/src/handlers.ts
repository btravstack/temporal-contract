// Top-level helpers for binding signal / query / update handlers to a
// running workflow. Previously nested inside `declareWorkflow`'s closure
// (#185), they're hoisted here so the bodies aren't reallocated on each
// workflow invocation. The typed call-site surface is preserved at the
// context-assignment site in `workflow.ts` (the arrow that forwards into
// these helpers carries the contract-derived generic constraints).
//
// Internally these are loosely typed (string names, broad `*Definition`
// inputs); the call sites already do the cast against the typed
// `WorkflowContext` shape, so the typed-vs-runtime split is the same as
// it was before the hoist.
import type {
  AnyWorkflowDefinition,
  QueryDefinition,
  SignalDefinition,
  UpdateDefinition,
} from "@temporal-contract/contract";
import { summarizeIssues } from "@temporal-contract/contract";
import { defineQuery, defineSignal, defineUpdate, log, setHandler } from "@temporalio/workflow";

import { toWorkflowFailure } from "./activity-failure.js";
import {
  ContractMisuseError,
  QueryInputValidationError,
  QueryOutputValidationError,
  UpdateInputValidationError,
  UpdateOutputValidationError,
} from "./errors.js";
import { extractHandlerInput } from "./shared.js";
import type { WorkerInferInput, WorkerInferOutput } from "./types.js";

/**
 * Signal handler implementation
 *
 * Processes signal input and can optionally perform asynchronous operations.
 * Should not return a value (signals are fire-and-forget).
 */
export type SignalHandlerImplementation<TSignal extends SignalDefinition> = (
  args: WorkerInferInput<TSignal>,
) => void | Promise<void>;

/**
 * Query handler implementation
 *
 * Processes query input and returns a synchronous response.
 * Must be synchronous to satisfy Temporal's query constraints.
 */
export type QueryHandlerImplementation<TQuery extends QueryDefinition> = (
  args: WorkerInferInput<TQuery>,
) => WorkerInferOutput<TQuery>;

/**
 * Update handler implementation
 *
 * Processes update input and returns a validated response after modifying workflow state.
 * Can perform asynchronous operations.
 */
export type UpdateHandlerImplementation<TUpdate extends UpdateDefinition> = (
  args: WorkerInferInput<TUpdate>,
) => Promise<WorkerInferOutput<TUpdate>>;

/**
 * The (verbatim-shared) message for the update input schema's sync-only
 * requirement — Temporal's update validator slot is synchronous, and the
 * same schema is re-run inside the handler body, so both call sites must
 * report the identical constraint.
 */
function updateInputMustBeSynchronousMessage(updateName: string): string {
  return (
    `Update "${updateName}" input validation must be synchronous. Use a schema library that ` +
    `supports synchronous validation for update inputs (Temporal's update validator slot is synchronous).`
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Per-call guard for the sync-only schema slots (query input/output, update
 * input). Standard Schema permits `validate` to return a Promise (e.g. Zod
 * with an async `.refine`), but Temporal runs query handlers and the update
 * validator slot synchronously, so every call checks the result's shape and
 * trips {@link ContractMisuseError} on an async one. There is no bind-time
 * check: a schema may go async only for some inputs (`.refine(async)` runs
 * after the synchronous base check passes), so only the real payload tells.
 *
 * Structural (`then`-able), not `instanceof Promise`: an implementation may
 * legally hand back any `PromiseLike`, and missing one would read `.issues`
 * (`undefined` → "no issues") and `.value` straight off the thenable,
 * silently handing the handler an unvalidated `undefined`. A detected
 * thenable's settlement is detached: nothing awaits it, and a rejection would
 * otherwise surface as an unhandled rejection while the
 * {@link ContractMisuseError} is in flight.
 */
function isAsyncValidation(result: unknown): result is PromiseLike<unknown> {
  if (!isThenable(result)) return false;
  result.then(
    () => undefined,
    () => undefined,
  );
  return true;
}

/**
 * Bind a typed signal handler to the running workflow. Validates the
 * signal payload against the contract's input schema before invoking the
 * user-supplied handler.
 *
 * An invalid payload is **dropped and logged** (`log.warn` via
 * `@temporalio/workflow`'s workflow-safe logger), never thrown: signals are
 * fire-and-forget messages that any stale or non-typed client can send, and
 * throwing a non-retryable failure from the signal handler would terminally
 * kill the whole workflow execution over a message the workflow never asked
 * for.
 *
 * The runtime guard against a missing `signals` block — and an unknown
 * signal name within it — covers the union-typed-`workflowName` case
 * where the type system's keyset constraint collapses; without the
 * check, a caller would see `Cannot read properties of undefined`
 * instead of a controlled error. Both guards throw
 * {@link ContractMisuseError} (a non-retryable `ApplicationFailure`) so the
 * programming bug fails the execution terminally instead of hanging it in
 * an infinite Workflow Task retry loop.
 *
 * A library error the handler throws (`throw context.errors.X(...)`,
 * `throw result.error`) fails the workflow with the Temporal failure it
 * carries — the same mapping `declareWorkflow` applies to the implementation.
 */
export function bindSignalHandler(
  workflowDefinition: AnyWorkflowDefinition,
  workflowName: string,
  signalName: string,
  handler: SignalHandlerImplementation<SignalDefinition>,
): void {
  if (!workflowDefinition.signals) {
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(
      `Signal "${signalName}" cannot be defined: workflow "${workflowName}" has no signals in its contract`,
    );
  }
  const signals = workflowDefinition.signals as Record<string, SignalDefinition>;
  const signalDef = Object.hasOwn(signals, signalName) ? signals[signalName] : undefined;
  if (!signalDef) {
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(
      `Signal "${signalName}" not found in workflow "${workflowName}" contract`,
    );
  }

  const signal = defineSignal(signalName);
  setHandler(signal, async (...args: unknown[]) => {
    const input = extractHandlerInput(args);
    const inputResult = await signalDef.input["~standard"].validate(input);
    if (inputResult.issues) {
      // Drop-and-log policy (fire-and-forget semantics): an invalid payload
      // must not fail the execution. `log.warn` is replay-aware, so the
      // warning is emitted once, not on every replay.
      log.warn(
        `Dropped signal "${signalName}": input validation failed: ${summarizeIssues(inputResult.issues)}`,
      );
      return;
    }
    try {
      await handler(inputResult.value);
    } catch (error) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ApplicationFailure model: a library error thrown by the handler must reach Temporal as a TemporalFailure, or the workflow task retries forever (CLAUDE.md rule 2 exception)
      throw await toWorkflowFailure(error, workflowDefinition.errors, `workflow "${workflowName}"`);
    }
  });
}

/**
 * Bind a typed query handler to the running workflow. Parses the input
 * (receive side of the boundary — the client validated but transmitted
 * the caller's original value) and validates the output, returning the
 * handler's ORIGINAL return value to Temporal — the client parses the
 * query result on receive, so a transforming output schema applies
 * exactly once. Both run synchronously.
 *
 * Temporal's query API requires a synchronous handler — async
 * validation breaks replay determinism. The handler trips a clear
 * {@link ContractMisuseError} if the schema library returns a Promise from
 * `validate(...)`, instead of letting the async path silently corrupt query
 * semantics.
 */
export function bindQueryHandler(
  workflowDefinition: AnyWorkflowDefinition,
  workflowName: string,
  queryName: string,
  handler: QueryHandlerImplementation<QueryDefinition>,
): void {
  if (!workflowDefinition.queries) {
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(
      `Query "${queryName}" cannot be defined: workflow "${workflowName}" has no queries in its contract`,
    );
  }
  const queries = workflowDefinition.queries as Record<string, QueryDefinition>;
  const queryDef = Object.hasOwn(queries, queryName) ? queries[queryName] : undefined;
  if (!queryDef) {
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(
      `Query "${queryName}" not found in workflow "${workflowName}" contract`,
    );
  }

  const query = defineQuery(queryName);
  setHandler(query, (...args: unknown[]) => {
    const input = extractHandlerInput(args);
    const inputResult = queryDef.input["~standard"].validate(input);

    if (isAsyncValidation(inputResult)) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new ContractMisuseError(
        `Query "${queryName}" validation must be synchronous. Use a schema library that supports synchronous validation for queries.`,
      );
    }
    if (inputResult.issues) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new QueryInputValidationError(queryName, inputResult.issues);
    }

    const result = handler(inputResult.value);

    const outputResult = queryDef.output["~standard"].validate(result);
    if (isAsyncValidation(outputResult)) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new ContractMisuseError(
        `Query "${queryName}" output validation must be synchronous. Use a schema library that supports synchronous validation for queries.`,
      );
    }
    if (outputResult.issues) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new QueryOutputValidationError(queryName, outputResult.issues);
    }

    // Validated, but the handler's ORIGINAL return goes over the wire —
    // the client parses the query result on receive (D1).
    return result;
  });
}

/**
 * Bind a typed update handler to the running workflow.
 *
 * Input validation runs in Temporal's `validator` slot — a synchronous
 * pre-admission hook. If it throws, Temporal rejects the update *before*
 * appending a workflow history event: clients see
 * `WorkflowUpdateValidationRejectedError` and the workflow's history is
 * unaffected. This is the documented contract for `setHandler`'s
 * `validator` option, and it is strictly better than running validation
 * inside the handler body — which forces Temporal to admit the update,
 * write a history event, and surface a `WorkflowUpdateFailedError` to
 * the client only after the fact.
 *
 * Because the validator slot is synchronous, the input schema must also
 * validate synchronously. Standard Schema is allowed to be async (Zod's
 * `.refine(async)` is the typical case), but we trip a clear
 * {@link ContractMisuseError} when that happens rather than silently
 * breaking admission semantics — same approach as `bindQueryHandler`.
 * Users who need async input checks should run them inside the handler
 * body and accept the post-admission failure mode, or restructure their
 * schema.
 *
 * Output validation continues to run inside the handler body. Update
 * outputs are *not* admission-gated — the handler must execute to
 * produce a value to validate against — so the async-allowed shape is
 * preserved. As with every payload boundary, the handler's ORIGINAL
 * return value is what crosses the wire: the client parses the update
 * result on receive, so a transforming output schema applies exactly
 * once.
 */
export function bindUpdateHandler(
  workflowDefinition: AnyWorkflowDefinition,
  workflowName: string,
  updateName: string,
  handler: UpdateHandlerImplementation<UpdateDefinition>,
): void {
  if (!workflowDefinition.updates) {
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(
      `Update "${updateName}" cannot be defined: workflow "${workflowName}" has no updates in its contract`,
    );
  }
  const updates = workflowDefinition.updates as Record<string, UpdateDefinition>;
  const updateDef = Object.hasOwn(updates, updateName) ? updates[updateName] : undefined;
  if (!updateDef) {
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(
      `Update "${updateName}" not found in workflow "${workflowName}" contract`,
    );
  }

  const update = defineUpdate(updateName);
  setHandler(
    update,
    async (...args: unknown[]) => {
      // The validator already accepted the payload (its parsed value is
      // discarded — it only gates admission). This is the boundary's single
      // receive-side parse: it always starts from the raw wire payload, so
      // the handler receives the schema's transformed value (Standard
      // Schema may rewrite shapes during validation, e.g. Zod `.transform`)
      // with the transform applied exactly once. It is sync because the
      // validator already proved the schema is sync; any async result here
      // would mean the schema changed under us, which is a programmer error
      // worth surfacing.
      const input = extractHandlerInput(args);
      const inputResult = updateDef.input["~standard"].validate(input);
      if (isAsyncValidation(inputResult)) {
        // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
        throw new ContractMisuseError(updateInputMustBeSynchronousMessage(updateName));
      }
      if (inputResult.issues) {
        // The validator should have caught this; if we reach here, the
        // schema produced different issues on a second call (non-pure
        // validator). Surface it as the same typed error class for
        // consistency.
        // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
        throw new UpdateInputValidationError(updateName, inputResult.issues);
      }

      let result: unknown;
      try {
        result = await handler(inputResult.value);
      } catch (error) {
        // oxlint-disable-next-line unthrown/no-throw -- sanctioned ApplicationFailure model: a library error thrown by the handler must reach Temporal as a TemporalFailure to reject the update, or the workflow task retries forever (CLAUDE.md rule 2 exception)
        throw await toWorkflowFailure(
          error,
          workflowDefinition.errors,
          `workflow "${workflowName}"`,
        );
      }

      const outputResult = await updateDef.output["~standard"].validate(result);
      if (outputResult.issues) {
        // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
        throw new UpdateOutputValidationError(updateName, outputResult.issues);
      }

      // Validated, but the handler's ORIGINAL return goes over the wire —
      // the client parses the update result on receive (D1).
      return result;
    },
    {
      validator: (...args: unknown[]) => {
        const input = extractHandlerInput(args);
        const inputResult = updateDef.input["~standard"].validate(input);

        if (isAsyncValidation(inputResult)) {
          // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: non-retryable ApplicationFailure Temporal must see thrown (CLAUDE.md rule 2 exception)
          throw new ContractMisuseError(updateInputMustBeSynchronousMessage(updateName));
        }
        if (inputResult.issues) {
          // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
          throw new UpdateInputValidationError(updateName, inputResult.issues);
        }
      },
    },
  );
}
