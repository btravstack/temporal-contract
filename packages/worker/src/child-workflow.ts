/**
 * Child workflow types + helpers used by `declareWorkflow`. Split out of
 * `workflow.ts` to keep that file focused on `declareWorkflow` and its
 * `WorkflowContext` type. Not part of the worker package's public exports.
 */
import type { AnyWorkflowDefinition, ContractDefinition } from "@temporal-contract/contract";
import {
  type ChildWorkflowHandle,
  type ChildWorkflowOptions,
  executeChild,
  startChild,
  type Workflow,
} from "@temporalio/workflow";
import { type AsyncResult, type Result, Ok, Err } from "unthrown";

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
import type { ClientInferInput, ClientInferOutput } from "./types.js";

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
   * Child workflow ID.
   */
  workflowId: string;
};

/**
 * Parse a child workflow's result against its output schema. The parent is
 * the RECEIVING side of the result boundary — the child validated its return
 * and transmitted the original value, so the parse (and any schema
 * transform) happens exactly once, here.
 */
async function validateChildWorkflowOutput<TChildWorkflow extends AnyWorkflowDefinition>(
  childDefinition: TChildWorkflow,
  result: unknown,
  childWorkflowName: string,
): Promise<Result<ClientInferOutput<TChildWorkflow>, ChildWorkflowError>> {
  const outputResult = await childDefinition.output["~standard"].validate(result);
  if (outputResult.issues) {
    return Err(
      new ChildWorkflowError(
        formatChildWorkflowValidationMessage(childWorkflowName, "output", outputResult.issues),
      ),
    );
  }
  return Ok(outputResult.value as ClientInferOutput<TChildWorkflow>);
}

/**
 * Resolve the child-workflow definition and validate `args` against its
 * input schema. The parent is the SENDING side of the input boundary, so
 * the parsed value is discarded — the caller transmits the original `args`
 * and the child's `declareWorkflow` parses them on receive, applying a
 * transforming schema exactly once.
 */
async function getAndValidateChildWorkflow<
  TChildContract extends ContractDefinition,
  TChildWorkflowName extends keyof TChildContract["workflows"] & string,
>(
  childContract: TChildContract,
  childWorkflowName: TChildWorkflowName,
  args: unknown,
): Promise<
  Result<
    {
      definition: TChildContract["workflows"][TChildWorkflowName];
      taskQueue: string;
    },
    ChildWorkflowError | ChildWorkflowNotFoundError
  >
> {
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
        formatChildWorkflowValidationMessage(childWorkflowName, "input", inputResult.issues),
      ),
    );
  }

  return Ok({
    definition: childDefinition as TChildContract["workflows"][TChildWorkflowName],
    taskQueue: childContract.taskQueue,
  });
}

function createTypedChildHandle<TChildWorkflow extends AnyWorkflowDefinition>(
  handle: ChildWorkflowHandle<Workflow>,
  childDefinition: TChildWorkflow,
  childWorkflowName: string,
): TypedChildWorkflowHandle<TChildWorkflow> {
  return {
    workflowId: handle.workflowId,
    result: (): AsyncResult<
      ClientInferOutput<TChildWorkflow>,
      ChildWorkflowError | ChildWorkflowCancelledError
    > => {
      const work = async (): Promise<
        Result<ClientInferOutput<TChildWorkflow>, ChildWorkflowError | ChildWorkflowCancelledError>
      > => {
        try {
          const result = await handle.result();
          return validateChildWorkflowOutput(childDefinition, result, childWorkflowName);
        } catch (error) {
          return Err(classifyChildWorkflowError("result", error, childWorkflowName));
        }
      };
      return makeAsyncResult(work);
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
  const work = async (): Promise<
    Result<Ok, ChildWorkflowError | ChildWorkflowCancelledError | ChildWorkflowNotFoundError>
  > => {
    const validationResult = await getAndValidateChildWorkflow(
      childContract,
      childWorkflowName,
      options.args,
    );

    // `getAndValidateChildWorkflow` only ever builds ok/err; assert away the
    // impossible defect so `.error` / `.value` narrow cleanly below.
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
  return makeAsyncResult(work);
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
  const work = async (): Promise<
    Result<Ok, ChildWorkflowError | ChildWorkflowCancelledError | ChildWorkflowNotFoundError>
  > => {
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
  return makeAsyncResult(work);
}
