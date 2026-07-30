/**
 * Child workflow types + helpers used by `declareWorkflow`. Split out of
 * `workflow.ts` to keep that file focused on `declareWorkflow` and its
 * `WorkflowContext` type. Not part of the worker package's public exports.
 */
import type {
  AnyWorkflowDefinition,
  ContractDefinition,
  InferSignalNames,
  SignalDefinition,
} from "@temporal-contract/contract";
import { summarizeIssues } from "@temporal-contract/contract";
import {
  type ChildWorkflowHandle,
  type ChildWorkflowOptions,
  executeChild,
  startChild,
  type Workflow,
} from "@temporalio/workflow";
import { type AsyncResult, Ok, Err } from "unthrown";

import {
  type ChildWorkflowCancelledError,
  ChildWorkflowError,
  ChildWorkflowNotFoundError,
} from "./errors.js";
import {
  assertNoDefect,
  classifyChildWorkflowError,
  formatChildWorkflowValidationMessage,
  makeAsyncResult,
} from "./internal.js";
import type { ClientInferInput, ClientInferOutput, SignalDefOf } from "./types.js";

/**
 * Options for starting a child workflow. `taskQueue` and `args` come from
 * the contract; everything else is forwarded to Temporal's
 * `startChild` / `executeChild`.
 */
export type TypedChildWorkflowOptions<
  TChildContract extends ContractDefinition,
  TChildWorkflowName extends keyof TChildContract["workflows"] & string,
> = Omit<ChildWorkflowOptions, "taskQueue" | "args"> & {
  args: ClientInferInput<TChildContract["workflows"][TChildWorkflowName]>;
};

/**
 * Typed signal senders for a child workflow, keyed by the signal names
 * declared on the child's contract entry. Mirrors the shape of the typed
 * client handle's `signals` proxy: one function per declared signal, taking
 * the signal's (client-perspective) input and returning an `AsyncResult`.
 *
 * Per the wire-format rule (D1), the sender validates `args` against the
 * signal's input schema — failing early with `Err(ChildWorkflowError)` —
 * but transmits the caller's ORIGINAL value; the child's signal handler
 * parses it on receive, so a transforming schema applies exactly once.
 */
export type TypedChildWorkflowSignals<TWorkflow extends AnyWorkflowDefinition> = {
  [K in InferSignalNames<TWorkflow>]: (
    args: ClientInferInput<SignalDefOf<TWorkflow, K>>,
  ) => AsyncResult<void, ChildWorkflowError | ChildWorkflowCancelledError>;
};

/**
 * Typed handle for a child workflow with unthrown `AsyncResult` pattern.
 */
export type TypedChildWorkflowHandle<TWorkflow extends AnyWorkflowDefinition> = {
  /**
   * Get child workflow result with `AsyncResult` pattern.
   */
  result: () => AsyncResult<
    ClientInferOutput<TWorkflow>,
    ChildWorkflowError | ChildWorkflowCancelledError
  >;

  /**
   * Typed signal senders for the child's declared signals — see
   * {@link TypedChildWorkflowSignals}. Empty when the child declares none.
   */
  signals: TypedChildWorkflowSignals<TWorkflow>;

  /**
   * Child workflow ID.
   */
  workflowId: string;

  /**
   * Run ID of the child's first execution — the anchor of its execution
   * chain (stable across continue-as-new), mirroring the field Temporal
   * exposes on its own `ChildWorkflowHandle`.
   */
  firstExecutionRunId: string;
};

/**
 * Parse a child workflow's result against its output schema. The parent is
 * the RECEIVING side of the result boundary — the child validated its return
 * and transmitted the original value, so the parse (and any schema
 * transform) happens exactly once, here.
 */
function validateChildWorkflowOutput<TChildWorkflow extends AnyWorkflowDefinition>(
  childDefinition: TChildWorkflow,
  result: unknown,
  childWorkflowName: string,
): AsyncResult<ClientInferOutput<TChildWorkflow>, ChildWorkflowError> {
  return makeAsyncResult<ClientInferOutput<TChildWorkflow>, ChildWorkflowError>(async () => {
    const outputResult = await childDefinition.output["~standard"].validate(result);
    if (outputResult.issues) {
      return Err(
        new ChildWorkflowError(
          childWorkflowName,
          formatChildWorkflowValidationMessage(childWorkflowName, "output", outputResult.issues),
        ),
      );
    }
    return Ok(outputResult.value as ClientInferOutput<TChildWorkflow>);
  });
}

/**
 * Resolve the child-workflow definition and validate `args` against its
 * input schema. The parent is the SENDING side of the input boundary, so
 * the parsed value is discarded — the caller transmits the original `args`
 * and the child's `declareWorkflow` parses them on receive, applying a
 * transforming schema exactly once.
 */
function getAndValidateChildWorkflow<
  TChildContract extends ContractDefinition,
  TChildWorkflowName extends keyof TChildContract["workflows"] & string,
>(
  childContract: TChildContract,
  childWorkflowName: TChildWorkflowName,
  args: unknown,
): AsyncResult<
  {
    definition: TChildContract["workflows"][TChildWorkflowName];
    taskQueue: string;
  },
  ChildWorkflowError | ChildWorkflowNotFoundError
> {
  return makeAsyncResult<
    {
      definition: TChildContract["workflows"][TChildWorkflowName];
      taskQueue: string;
    },
    ChildWorkflowError | ChildWorkflowNotFoundError
  >(async () => {
    const childDefinition = childContract.workflows[childWorkflowName];

    if (!childDefinition) {
      return Err(
        new ChildWorkflowNotFoundError(
          childWorkflowName,
          Object.keys(childContract.workflows) as string[],
        ),
      );
    }

    const inputResult = await childDefinition.input["~standard"].validate(args);
    if (inputResult.issues) {
      return Err(
        new ChildWorkflowError(
          childWorkflowName,
          formatChildWorkflowValidationMessage(childWorkflowName, "input", inputResult.issues),
        ),
      );
    }

    return Ok({
      definition: childDefinition as TChildContract["workflows"][TChildWorkflowName],
      taskQueue: childContract.taskQueue,
    });
  });
}

/**
 * Build the typed `signals` map for a child handle. One sender per signal
 * declared on the child's contract entry: validates `args` (fail early with
 * a descriptive `ChildWorkflowError`), then transmits the caller's ORIGINAL
 * value via `handle.signal` — the child parses on receive (D1). Errors from
 * the signal call itself are classified like the other child-workflow
 * operations (cancellation → `ChildWorkflowCancelledError`).
 */
function createTypedChildSignals<TChildWorkflow extends AnyWorkflowDefinition>(
  handle: ChildWorkflowHandle<Workflow>,
  childDefinition: TChildWorkflow,
  childWorkflowName: string,
): TypedChildWorkflowSignals<TChildWorkflow> {
  const signals: Record<
    string,
    (args: unknown) => AsyncResult<void, ChildWorkflowError | ChildWorkflowCancelledError>
  > = {};

  const signalDefs = (childDefinition.signals ?? {}) as Record<string, SignalDefinition>;
  for (const [signalName, signalDef] of Object.entries(signalDefs)) {
    signals[signalName] = (args: unknown) => {
      const work = async () => {
        const inputResult = await signalDef.input["~standard"].validate(args);
        if (inputResult.issues) {
          return Err(
            new ChildWorkflowError(
              childWorkflowName,
              `Child workflow "${childWorkflowName}" signal "${signalName}" input validation failed: ${summarizeIssues(inputResult.issues)}`,
            ),
          );
        }
        try {
          // Transmit the caller's ORIGINAL args — validated above, parsed by
          // the child's signal handler on receive (D1).
          await handle.signal(signalName, args);
          return Ok(undefined);
        } catch (error) {
          return Err(classifyChildWorkflowError("signal", error, childWorkflowName));
        }
      };
      return makeAsyncResult<void, ChildWorkflowError | ChildWorkflowCancelledError>(work);
    };
  }

  return signals as TypedChildWorkflowSignals<TChildWorkflow>;
}

function createTypedChildHandle<TChildWorkflow extends AnyWorkflowDefinition>(
  handle: ChildWorkflowHandle<Workflow>,
  childDefinition: TChildWorkflow,
  childWorkflowName: string,
): TypedChildWorkflowHandle<TChildWorkflow> {
  return {
    workflowId: handle.workflowId,
    firstExecutionRunId: handle.firstExecutionRunId,
    signals: createTypedChildSignals(handle, childDefinition, childWorkflowName),
    result: (): AsyncResult<
      ClientInferOutput<TChildWorkflow>,
      ChildWorkflowError | ChildWorkflowCancelledError
    > => {
      const work = async () => {
        try {
          const result = await handle.result();
          return validateChildWorkflowOutput(childDefinition, result, childWorkflowName);
        } catch (error) {
          return Err(classifyChildWorkflowError("result", error, childWorkflowName));
        }
      };
      return makeAsyncResult<
        ClientInferOutput<TChildWorkflow>,
        ChildWorkflowError | ChildWorkflowCancelledError
      >(work);
    },
  };
}

export function createStartChildWorkflow<
  TChildContract extends ContractDefinition,
  TChildWorkflowName extends keyof TChildContract["workflows"] & string,
>(
  childContract: TChildContract,
  childWorkflowName: TChildWorkflowName,
  options: TypedChildWorkflowOptions<TChildContract, TChildWorkflowName>,
): AsyncResult<
  TypedChildWorkflowHandle<TChildContract["workflows"][TChildWorkflowName]>,
  ChildWorkflowError | ChildWorkflowCancelledError | ChildWorkflowNotFoundError
> {
  type Ok = TypedChildWorkflowHandle<TChildContract["workflows"][TChildWorkflowName]>;
  const work = async () => {
    const validationResult = await getAndValidateChildWorkflow(
      childContract,
      childWorkflowName,
      options.args,
    );

    // A technical throw inside the validator is captured as a defect;
    // re-throw it here (into this thunk's throw→defect net) so `.error` /
    // `.value` narrow cleanly below.
    assertNoDefect(validationResult);
    if (validationResult.isErr()) {
      return Err(validationResult.error);
    }

    const { definition: childDefinition, taskQueue } = validationResult.value;

    try {
      // Transmit the caller's ORIGINAL args — validated above, parsed by
      // the child workflow on receive (D1).
      const { args: childArgs, ...temporalOptions } = options;
      const handle = await startChild(childWorkflowName, {
        ...temporalOptions,
        taskQueue,
        args: [childArgs],
      });

      const typedHandle = createTypedChildHandle(handle, childDefinition, childWorkflowName) as Ok;

      return Ok(typedHandle);
    } catch (error) {
      return Err(classifyChildWorkflowError("startChild", error, String(childWorkflowName)));
    }
  };
  return makeAsyncResult<
    Ok,
    ChildWorkflowError | ChildWorkflowCancelledError | ChildWorkflowNotFoundError
  >(work);
}

export function createExecuteChildWorkflow<
  TChildContract extends ContractDefinition,
  TChildWorkflowName extends keyof TChildContract["workflows"] & string,
>(
  childContract: TChildContract,
  childWorkflowName: TChildWorkflowName,
  options: TypedChildWorkflowOptions<TChildContract, TChildWorkflowName>,
): AsyncResult<
  ClientInferOutput<TChildContract["workflows"][TChildWorkflowName]>,
  ChildWorkflowError | ChildWorkflowCancelledError | ChildWorkflowNotFoundError
> {
  type Ok = ClientInferOutput<TChildContract["workflows"][TChildWorkflowName]>;
  const work = async () => {
    const validationResult = await getAndValidateChildWorkflow(
      childContract,
      childWorkflowName,
      options.args,
    );

    assertNoDefect(validationResult);
    if (validationResult.isErr()) {
      return Err(validationResult.error);
    }

    const { definition: childDefinition, taskQueue } = validationResult.value;

    try {
      // Transmit the caller's ORIGINAL args — validated above, parsed by
      // the child workflow on receive (D1).
      const { args: childArgs, ...temporalOptions } = options;
      const result = await executeChild(childWorkflowName, {
        ...temporalOptions,
        taskQueue,
        args: [childArgs],
      });

      const outputValidationResult = await validateChildWorkflowOutput(
        childDefinition,
        result,
        childWorkflowName,
      );

      assertNoDefect(outputValidationResult);
      if (outputValidationResult.isErr()) {
        return Err(outputValidationResult.error);
      }

      return Ok(outputValidationResult.value as Ok);
    } catch (error) {
      return Err(classifyChildWorkflowError("executeChild", error, String(childWorkflowName)));
    }
  };
  return makeAsyncResult<
    Ok,
    ChildWorkflowError | ChildWorkflowCancelledError | ChildWorkflowNotFoundError
  >(work);
}
