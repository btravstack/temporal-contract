import type {
  ScheduleClient,
  ScheduleDescription,
  ScheduleHandle,
  ScheduleOptions,
  ScheduleOptionsStartWorkflowAction,
  ScheduleOverlapPolicy,
  ScheduleSpec,
} from "@temporalio/client";
import type { ContractDefinition } from "@temporal-contract/contract";
import { Future, Result } from "@swan-io/boxed";
import type { ClientInferInput } from "./types.js";
import { RuntimeClientError, WorkflowNotFoundError, WorkflowValidationError } from "./errors.js";

type StartWorkflowOptionsForwardable = Pick<
  ScheduleOptionsStartWorkflowAction<never>,
  | "workflowId"
  | "workflowExecutionTimeout"
  | "workflowRunTimeout"
  | "workflowTaskTimeout"
  | "retry"
  | "memo"
  | "staticDetails"
  | "staticSummary"
>;

/**
 * Options for {@link TypedScheduleClient.create}.
 *
 * `scheduleId` and `spec` come from Temporal's `ScheduleOptions`. `args` is
 * typed against the destination workflow's input schema. `policies`,
 * `state`, and `memo` mirror Temporal's own options. Workflow-action–level
 * overrides (`workflowId`, retry, timeouts, memo, etc.) live alongside —
 * `workflowType` and `taskQueue` are owned by the contract and not exposed.
 */
export type TypedScheduleCreateOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"],
> = {
  /** Schedule ID. Recommended to use a meaningful business identifier. */
  scheduleId: string;
  /** When the schedule should fire (cron, interval, calendar). */
  spec: ScheduleSpec;
  /** Workflow input — validated against the contract's input schema. */
  args: ClientInferInput<TContract["workflows"][TWorkflowName]>;
  /** Temporal schedule policies (overlap, catchupWindow, pauseOnFailure, etc.). */
  policies?: ScheduleOptions["policies"];
  /** Temporal schedule state (paused, note, limited, etc.). */
  state?: ScheduleOptions["state"];
  /** Schedule-level memo (non-indexed metadata on the schedule itself). */
  memo?: ScheduleOptions["memo"];
} & StartWorkflowOptionsForwardable;

/**
 * Typed handle to a schedule. Mirrors Temporal's `ScheduleHandle` lifecycle
 * methods (`pause`, `unpause`, `trigger`, `describe`, `delete`) wrapped in
 * the Future/Result pattern so call sites match the rest of the typed
 * client.
 */
export type TypedScheduleHandle = {
  /** This schedule's identifier. */
  readonly scheduleId: string;
  /** Pause the schedule. Optional note becomes part of the audit trail. */
  pause: (note?: string) => Future<Result<void, RuntimeClientError>>;
  /** Resume a paused schedule. */
  unpause: (note?: string) => Future<Result<void, RuntimeClientError>>;
  /** Fire the schedule's action immediately. */
  trigger: (overlap?: ScheduleOverlapPolicy) => Future<Result<void, RuntimeClientError>>;
  /** Delete the schedule. */
  delete: () => Future<Result<void, RuntimeClientError>>;
  /** Fetch the schedule's current description from the server. */
  describe: () => Future<Result<ScheduleDescription, RuntimeClientError>>;
};

/**
 * Typed wrapper around Temporal's `ScheduleClient`. Exposed as
 * `typedClient.schedule` — keeps the typed-client surface organized the
 * same way Temporal's own `Client.schedule` does.
 */
export class TypedScheduleClient<TContract extends ContractDefinition> {
  constructor(
    private readonly contract: TContract,
    private readonly scheduleClient: ScheduleClient,
  ) {}

  /**
   * Create a new schedule that, on each fire, starts the named contract
   * workflow with validated args.
   *
   * Validates `args` against the workflow's input schema before dispatching
   * the create request to Temporal. The workflow's `taskQueue` and
   * `workflowType` are pulled from the contract automatically; the typed
   * options shape Omits them so call sites don't have to repeat themselves.
   */
  create<TWorkflowName extends keyof TContract["workflows"]>(
    workflowName: TWorkflowName,
    options: TypedScheduleCreateOptions<TContract, TWorkflowName>,
  ): Future<
    Result<
      TypedScheduleHandle,
      WorkflowNotFoundError | WorkflowValidationError | RuntimeClientError
    >
  > {
    type Ok = TypedScheduleHandle;
    type Err = WorkflowNotFoundError | WorkflowValidationError | RuntimeClientError;
    const work = async (): Promise<Result<Ok, Err>> => {
      const definition = this.contract.workflows[workflowName as string];
      if (!definition) {
        return Result.Error(
          new WorkflowNotFoundError(String(workflowName), Object.keys(this.contract.workflows)),
        );
      }

      const inputResult = await definition.input["~standard"].validate(options.args);
      if (inputResult.issues) {
        return Result.Error(
          new WorkflowValidationError(String(workflowName), "input", inputResult.issues),
        );
      }

      try {
        const action: ScheduleOptionsStartWorkflowAction<never> = {
          type: "startWorkflow",
          workflowType: workflowName as string,
          taskQueue: this.contract.taskQueue,
          args: [inputResult.value] as never,
          ...(options.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
          ...(options.workflowExecutionTimeout !== undefined
            ? { workflowExecutionTimeout: options.workflowExecutionTimeout }
            : {}),
          ...(options.workflowRunTimeout !== undefined
            ? { workflowRunTimeout: options.workflowRunTimeout }
            : {}),
          ...(options.workflowTaskTimeout !== undefined
            ? { workflowTaskTimeout: options.workflowTaskTimeout }
            : {}),
          ...(options.retry !== undefined ? { retry: options.retry } : {}),
          ...(options.memo !== undefined ? { memo: options.memo } : {}),
          ...(options.staticDetails !== undefined ? { staticDetails: options.staticDetails } : {}),
          ...(options.staticSummary !== undefined ? { staticSummary: options.staticSummary } : {}),
        };

        const handle = await this.scheduleClient.create({
          scheduleId: options.scheduleId,
          spec: options.spec,
          action,
          ...(options.policies !== undefined ? { policies: options.policies } : {}),
          ...(options.state !== undefined ? { state: options.state } : {}),
          ...(options.memo !== undefined ? { memo: options.memo } : {}),
        });
        return Result.Ok(wrapScheduleHandle(handle));
      } catch (error) {
        return Result.Error(new RuntimeClientError("schedule.create", error));
      }
    };
    return makeFuture(work);
  }

  /**
   * Get a typed handle to an existing schedule. Does not validate that the
   * schedule exists — handle methods (`describe`, `pause`, etc.) will
   * surface a `RuntimeClientError` if the underlying ID is unknown.
   */
  getHandle(scheduleId: string): TypedScheduleHandle {
    return wrapScheduleHandle(this.scheduleClient.getHandle(scheduleId));
  }
}

function wrapScheduleHandle(handle: ScheduleHandle): TypedScheduleHandle {
  return {
    scheduleId: handle.scheduleId,
    pause: (note) =>
      Future.fromPromise(handle.pause(note))
        .mapError((error) => new RuntimeClientError("schedule.pause", error))
        .mapOk(() => undefined),
    unpause: (note) =>
      Future.fromPromise(handle.unpause(note))
        .mapError((error) => new RuntimeClientError("schedule.unpause", error))
        .mapOk(() => undefined),
    trigger: (overlap) =>
      Future.fromPromise(handle.trigger(overlap))
        .mapError((error) => new RuntimeClientError("schedule.trigger", error))
        .mapOk(() => undefined),
    delete: () =>
      Future.fromPromise(handle.delete())
        .mapError((error) => new RuntimeClientError("schedule.delete", error))
        .mapOk(() => undefined),
    describe: () =>
      Future.fromPromise(handle.describe()).mapError(
        (error) => new RuntimeClientError("schedule.describe", error),
      ),
  };
}

/**
 * Wrap an async `() => Promise<Result<...>>` in a `Future`, falling back to
 * `RuntimeClientError("unexpected", e)` for unhandled rejections so the
 * schedule paths match the rest of the typed client's error story.
 */
function makeFuture<T, E>(
  work: () => Promise<Result<T, E>>,
): Future<Result<T, E | RuntimeClientError>> {
  return Future.make((resolve) => {
    work()
      .then(resolve)
      .catch((e: unknown) =>
        resolve(Result.Error<T, E | RuntimeClientError>(new RuntimeClientError("unexpected", e))),
      );
  });
}
