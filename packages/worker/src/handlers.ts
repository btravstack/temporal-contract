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
import { defineQuery, defineSignal, defineUpdate, setHandler } from "@temporalio/workflow";
import {
  QueryInputValidationError,
  QueryOutputValidationError,
  SignalInputValidationError,
  UpdateInputValidationError,
  UpdateOutputValidationError,
} from "./errors.js";
import { extractHandlerInput } from "./internal.js";
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
 * Bind a typed signal handler to the running workflow. Validates the
 * signal payload against the contract's input schema before invoking the
 * user-supplied handler.
 *
 * The runtime guard against a missing `signals` block — and an unknown
 * signal name within it — covers the union-typed-`workflowName` case
 * where the type system's keyset constraint collapses; without the
 * check, a caller would see `Cannot read properties of undefined`
 * instead of a controlled error.
 */
export function bindSignalHandler(
  workflowDefinition: AnyWorkflowDefinition,
  workflowName: string,
  signalName: string,
  handler: SignalHandlerImplementation<SignalDefinition>,
): void {
  if (!workflowDefinition.signals) {
    throw new Error(
      `Signal "${signalName}" cannot be defined: workflow "${workflowName}" has no signals in its contract`,
    );
  }
  const signalDef = (workflowDefinition.signals as Record<string, SignalDefinition>)[signalName];
  if (!signalDef) {
    throw new Error(`Signal "${signalName}" not found in workflow "${workflowName}" contract`);
  }

  const signal = defineSignal(signalName);
  setHandler(signal, async (...args: unknown[]) => {
    const input = extractHandlerInput(args);
    const inputResult = await signalDef.input["~standard"].validate(input);
    if (inputResult.issues) {
      throw new SignalInputValidationError(signalName, inputResult.issues);
    }
    await handler(inputResult.value);
  });
}

/**
 * Bind a typed query handler to the running workflow. Validates input
 * and output against the contract synchronously.
 *
 * Temporal's query API requires a synchronous handler — async
 * validation breaks replay determinism. The handler trips a clear error
 * if the schema library returns a Promise from `validate(...)`, instead
 * of letting the async path silently corrupt query semantics.
 */
export function bindQueryHandler(
  workflowDefinition: AnyWorkflowDefinition,
  workflowName: string,
  queryName: string,
  handler: QueryHandlerImplementation<QueryDefinition>,
): void {
  if (!workflowDefinition.queries) {
    throw new Error(
      `Query "${queryName}" cannot be defined: workflow "${workflowName}" has no queries in its contract`,
    );
  }
  const queryDef = (workflowDefinition.queries as Record<string, QueryDefinition>)[queryName];
  if (!queryDef) {
    throw new Error(`Query "${queryName}" not found in workflow "${workflowName}" contract`);
  }

  const query = defineQuery(queryName);
  setHandler(query, (...args: unknown[]) => {
    const input = extractHandlerInput(args);
    const inputResult = queryDef.input["~standard"].validate(input);

    if (inputResult instanceof Promise) {
      throw new Error(
        `Query "${queryName}" validation must be synchronous. Use a schema library that supports synchronous validation for queries.`,
      );
    }
    if (inputResult.issues) {
      throw new QueryInputValidationError(queryName, inputResult.issues);
    }

    const result = handler(inputResult.value);

    const outputResult = queryDef.output["~standard"].validate(result);
    if (outputResult instanceof Promise) {
      throw new Error(
        `Query "${queryName}" output validation must be synchronous. Use a schema library that supports synchronous validation for queries.`,
      );
    }
    if (outputResult.issues) {
      throw new QueryOutputValidationError(queryName, outputResult.issues);
    }

    return outputResult.value;
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
 * `.refine(async)` is the typical case), but we trip a clear error when
 * that happens rather than silently breaking admission semantics — same
 * approach as `bindQueryHandler`. Users who need async input checks
 * should run them inside the handler body and accept the post-admission
 * failure mode, or restructure their schema.
 *
 * Output validation continues to run inside the handler body. Update
 * outputs are *not* admission-gated — the handler must execute to
 * produce a value to validate against — so the async-allowed shape is
 * preserved.
 */
export function bindUpdateHandler(
  workflowDefinition: AnyWorkflowDefinition,
  workflowName: string,
  updateName: string,
  handler: UpdateHandlerImplementation<UpdateDefinition>,
): void {
  if (!workflowDefinition.updates) {
    throw new Error(
      `Update "${updateName}" cannot be defined: workflow "${workflowName}" has no updates in its contract`,
    );
  }
  const updateDef = (workflowDefinition.updates as Record<string, UpdateDefinition>)[updateName];
  if (!updateDef) {
    throw new Error(`Update "${updateName}" not found in workflow "${workflowName}" contract`);
  }

  const update = defineUpdate(updateName);
  setHandler(
    update,
    async (...args: unknown[]) => {
      // The validator already accepted the payload — re-parse here so the
      // handler receives the schema's transformed value (Standard Schema
      // may rewrite shapes during validation, e.g. Zod `.transform`). This
      // is sync because the validator already proved the schema is sync;
      // any async result here would mean the schema changed under us,
      // which is a programmer error worth surfacing.
      const input = extractHandlerInput(args);
      const inputResult = updateDef.input["~standard"].validate(input);
      if (inputResult instanceof Promise) {
        throw new Error(
          `Update "${updateName}" input validation must be synchronous. Use a schema library that supports synchronous validation for update inputs (Temporal's update validator slot is synchronous).`,
        );
      }
      if (inputResult.issues) {
        // The validator should have caught this; if we reach here, the
        // schema produced different issues on a second call (non-pure
        // validator). Surface it as the same typed error class for
        // consistency.
        throw new UpdateInputValidationError(updateName, inputResult.issues);
      }

      const result = await handler(inputResult.value);

      const outputResult = await updateDef.output["~standard"].validate(result);
      if (outputResult.issues) {
        throw new UpdateOutputValidationError(updateName, outputResult.issues);
      }

      return outputResult.value;
    },
    {
      validator: (...args: unknown[]) => {
        const input = extractHandlerInput(args);
        const inputResult = updateDef.input["~standard"].validate(input);

        if (inputResult instanceof Promise) {
          throw new Error(
            `Update "${updateName}" input validation must be synchronous. Use a schema library that supports synchronous validation for update inputs (Temporal's update validator slot is synchronous).`,
          );
        }
        if (inputResult.issues) {
          throw new UpdateInputValidationError(updateName, inputResult.issues);
        }
      },
    },
  );
}
