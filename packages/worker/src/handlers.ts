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
  QueryDefinition,
  SignalDefinition,
  UpdateDefinition,
  WorkflowDefinition,
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
  workflowDefinition: WorkflowDefinition,
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
  workflowDefinition: WorkflowDefinition,
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
 * Bind a typed update handler to the running workflow. Validates both
 * input and output (asynchronously, like signals).
 */
export function bindUpdateHandler(
  workflowDefinition: WorkflowDefinition,
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
  setHandler(update, async (...args: unknown[]) => {
    const input = extractHandlerInput(args);
    const inputResult = await updateDef.input["~standard"].validate(input);
    if (inputResult.issues) {
      throw new UpdateInputValidationError(updateName, inputResult.issues);
    }

    const result = await handler(inputResult.value);

    const outputResult = await updateDef.output["~standard"].validate(result);
    if (outputResult.issues) {
      throw new UpdateOutputValidationError(updateName, outputResult.issues);
    }

    return outputResult.value;
  });
}
