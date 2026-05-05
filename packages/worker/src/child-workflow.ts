/**
 * Child workflow types + helpers used by `declareWorkflow`. Split out of
 * `workflow.ts` to keep that file focused on `declareWorkflow` and its
 * `WorkflowContext` type. Not part of the worker package's public exports.
 */
import type { AnyWorkflowDefinition, ContractDefinition } from "@temporal-contract/contract";
import {
  ChildWorkflowHandle,
  ChildWorkflowOptions,
  executeChild,
  startChild,
} from "@temporalio/workflow";
import { ResultAsync, type Result, ok, err } from "neverthrow";
import {
  ChildWorkflowCancelledError,
  ChildWorkflowError,
  ChildWorkflowNotFoundError,
} from "./errors.js";
import {
  classifyChildWorkflowError,
  formatChildWorkflowValidationMessage,
  makeResultAsync,
} from "./internal.js";
import type { ClientInferInput, ClientInferOutput, WorkerInferInput } from "./types.js";

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
 * Typed handle for a child workflow with neverthrow `ResultAsync` pattern.
 */
export type TypedChildWorkflowHandle<TWorkflow extends AnyWorkflowDefinition> = {
  /**
   * Get child workflow result with `ResultAsync` pattern.
   */
  result: () => ResultAsync<
    ClientInferOutput<TWorkflow>,
    ChildWorkflowError | ChildWorkflowCancelledError
  >;

  /**
   * Child workflow ID.
   */
  workflowId: string;
};

async function validateChildWorkflowOutput<TChildWorkflow extends AnyWorkflowDefinition>(
  childDefinition: TChildWorkflow,
  result: unknown,
  childWorkflowName: string,
): Promise<Result<ClientInferOutput<TChildWorkflow>, ChildWorkflowError>> {
  const outputResult = await childDefinition.output["~standard"].validate(result);
  if (outputResult.issues) {
    return err(
      new ChildWorkflowError(
        formatChildWorkflowValidationMessage(childWorkflowName, "output", outputResult.issues),
      ),
    );
  }
  return ok(outputResult.value as ClientInferOutput<TChildWorkflow>);
}

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
      validatedInput: WorkerInferInput<TChildContract["workflows"][TChildWorkflowName]>;
      taskQueue: string;
    },
    ChildWorkflowError
  >
> {
  const childDefinition = childContract.workflows[childWorkflowName];

  if (!childDefinition) {
    return err(
      new ChildWorkflowNotFoundError(
        childWorkflowName,
        Object.keys(childContract.workflows) as string[],
      ),
    );
  }

  const inputResult = await childDefinition.input["~standard"].validate(args);
  if (inputResult.issues) {
    return err(
      new ChildWorkflowError(
        formatChildWorkflowValidationMessage(childWorkflowName, "input", inputResult.issues),
      ),
    );
  }

  const validatedInput = inputResult.value as WorkerInferInput<
    TChildContract["workflows"][TChildWorkflowName]
  >;

  return ok({
    definition: childDefinition as TChildContract["workflows"][TChildWorkflowName],
    validatedInput,
    taskQueue: childContract.taskQueue,
  });
}

function createTypedChildHandle<TChildWorkflow extends AnyWorkflowDefinition>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle: ChildWorkflowHandle<any>,
  childDefinition: TChildWorkflow,
  childWorkflowName: string,
): TypedChildWorkflowHandle<TChildWorkflow> {
  return {
    workflowId: handle.workflowId,
    result: (): ResultAsync<
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
          return err(classifyChildWorkflowError("result", error, childWorkflowName));
        }
      };
      return makeResultAsync(
        work,
        (error) =>
          new ChildWorkflowError(
            `Child workflow execution failed: ${error instanceof Error ? error.message : String(error)}`,
            error,
          ),
      );
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
): ResultAsync<
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

    if (validationResult.isErr()) {
      return err(validationResult.error);
    }

    const { definition: childDefinition, validatedInput, taskQueue } = validationResult.value;

    try {
      const { args: _args, ...temporalOptions } = options;
      const handle = await startChild(childWorkflowName, {
        ...temporalOptions,
        taskQueue,
        args: [validatedInput],
      });

      const typedHandle = createTypedChildHandle(handle, childDefinition, childWorkflowName) as Ok;

      return ok(typedHandle);
    } catch (error) {
      return err(classifyChildWorkflowError("startChild", error, String(childWorkflowName)));
    }
  };
  return makeResultAsync(
    work,
    (error) =>
      new ChildWorkflowError(
        `Failed to start child workflow: ${error instanceof Error ? error.message : String(error)}`,
        error,
      ),
  );
}

export function createExecuteChildWorkflow<
  TChildContract extends ContractDefinition,
  TChildWorkflowName extends keyof TChildContract["workflows"] & string,
>(
  childContract: TChildContract,
  childWorkflowName: TChildWorkflowName,
  options: TypedChildWorkflowOptions<TChildContract, TChildWorkflowName>,
): ResultAsync<
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

    if (validationResult.isErr()) {
      return err(validationResult.error);
    }

    const { definition: childDefinition, validatedInput, taskQueue } = validationResult.value;

    try {
      const { args: _args, ...temporalOptions } = options;
      const result = await executeChild(childWorkflowName, {
        ...temporalOptions,
        taskQueue,
        args: [validatedInput],
      });

      const outputValidationResult = await validateChildWorkflowOutput(
        childDefinition,
        result,
        childWorkflowName,
      );

      if (outputValidationResult.isErr()) {
        return err(outputValidationResult.error);
      }

      return ok(outputValidationResult.value as Ok);
    } catch (error) {
      return err(classifyChildWorkflowError("executeChild", error, String(childWorkflowName)));
    }
  };
  return makeResultAsync(
    work,
    (error) =>
      new ChildWorkflowError(
        `Failed to execute child workflow: ${error instanceof Error ? error.message : String(error)}`,
        error,
      ),
  );
}
