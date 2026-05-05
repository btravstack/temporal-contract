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
import { ResultAsync, type Result, ok, err } from "neverthrow";
import type { TypedSearchAttributeMap } from "./client.js";
import type { ClientInferInput } from "./types.js";
import { RuntimeClientError, WorkflowNotFoundError, WorkflowValidationError } from "./errors.js";
import { makeResultAsync, toTypedSearchAttributes } from "./internal.js";

/**
 * Workflow-action–level overrides forwarded to Temporal's
 * `ScheduleOptionsStartWorkflowAction`. These live under a nested `action`
 * field so the workflow-level `memo` (per-action workflow metadata) can be
 * set independently from the schedule-level `memo` (metadata on the
 * schedule itself) — Temporal honours both, and they have separate
 * lifecycles.
 *
 * `workflowType` and `taskQueue` are owned by the contract and not exposed.
 */
export type TypedScheduleActionOverrides = Pick<
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
 * `state`, and `memo` mirror Temporal's own schedule-level options.
 * Workflow-action–level overrides nest under {@link action} so memo and
 * other fields with the same name don't collide between the two scopes.
 */
export type TypedScheduleCreateOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
> = {
  /** Schedule ID. Recommended to use a meaningful business identifier. */
  scheduleId: string;
  /** When the schedule should fire (cron, interval, calendar). */
  spec: ScheduleSpec;
  /** Workflow input — validated against the contract's input schema. */
  args: ClientInferInput<TContract["workflows"][TWorkflowName]>;
  /**
   * Indexed search attributes for each workflow run spawned by this
   * schedule. Keys and value types are constrained to those declared on
   * the destination workflow's contract via `defineSearchAttribute`.
   * Translated to Temporal's `typedSearchAttributes` and attached to the
   * schedule's `startWorkflow` action so each spawned run is indexed
   * identically to one started directly via `client.startWorkflow`.
   */
  searchAttributes?: TypedSearchAttributeMap<TContract["workflows"][TWorkflowName]>;
  /** Temporal schedule policies (overlap, catchupWindow, pauseOnFailure, etc.). */
  policies?: ScheduleOptions["policies"];
  /** Temporal schedule state (paused, note, limited, etc.). */
  state?: ScheduleOptions["state"];
  /** Schedule-level memo (non-indexed metadata on the schedule itself). */
  memo?: ScheduleOptions["memo"];
  /**
   * Workflow-action–level overrides. `workflowType` and `taskQueue` are
   * derived from the contract, so they don't appear here. Note that
   * `action.memo` is a *workflow-level* memo applied to each spawned run,
   * distinct from the top-level `memo` (which is metadata on the schedule
   * itself).
   */
  action?: TypedScheduleActionOverrides;
};

/**
 * Typed handle to a schedule. Mirrors Temporal's `ScheduleHandle` lifecycle
 * methods (`pause`, `unpause`, `trigger`, `describe`, `delete`) wrapped in
 * the neverthrow ResultAsync pattern so call sites match the rest of the
 * typed client.
 */
export type TypedScheduleHandle = {
  /** This schedule's identifier. */
  readonly scheduleId: string;
  /** Pause the schedule. Optional note becomes part of the audit trail. */
  pause: (note?: string) => ResultAsync<void, RuntimeClientError>;
  /** Resume a paused schedule. */
  unpause: (note?: string) => ResultAsync<void, RuntimeClientError>;
  /** Fire the schedule's action immediately. */
  trigger: (overlap?: ScheduleOverlapPolicy) => ResultAsync<void, RuntimeClientError>;
  /** Delete the schedule. */
  delete: () => ResultAsync<void, RuntimeClientError>;
  /** Fetch the schedule's current description from the server. */
  describe: () => ResultAsync<ScheduleDescription, RuntimeClientError>;
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
   * options shape omits them so call sites don't have to repeat themselves.
   */
  create<TWorkflowName extends keyof TContract["workflows"] & string>(
    workflowName: TWorkflowName,
    options: TypedScheduleCreateOptions<TContract, TWorkflowName>,
  ): ResultAsync<
    TypedScheduleHandle,
    WorkflowNotFoundError | WorkflowValidationError | RuntimeClientError
  > {
    type Ok = TypedScheduleHandle;
    type Err = WorkflowNotFoundError | WorkflowValidationError | RuntimeClientError;
    const work = async (): Promise<Result<Ok, Err>> => {
      const definition = this.contract.workflows[workflowName];
      if (!definition) {
        return err(new WorkflowNotFoundError(workflowName, Object.keys(this.contract.workflows)));
      }

      const inputResult = await definition.input["~standard"].validate(options.args);
      if (inputResult.issues) {
        return err(new WorkflowValidationError(workflowName, "input", inputResult.issues));
      }

      // Translate typed search attributes for the spawned workflow runs.
      // Lives on the schedule's `startWorkflow` action (workflow-level
      // indexing), not on the schedule itself. Mirrors what
      // `client.startWorkflow` does for direct starts so schedule-spawned
      // runs share visibility with their direct-start counterparts.
      const searchAttributesResult = toTypedSearchAttributes(
        definition,
        workflowName,
        options.searchAttributes as Record<string, unknown> | undefined,
      );
      if (searchAttributesResult.isErr()) return err(searchAttributesResult.error);
      const typedSearchAttributes = searchAttributesResult.value;

      try {
        const overrides = options.action ?? {};
        const action: ScheduleOptionsStartWorkflowAction<never> = {
          type: "startWorkflow",
          workflowType: workflowName,
          taskQueue: this.contract.taskQueue,
          args: [inputResult.value] as never,
          ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
          ...(overrides.workflowId !== undefined ? { workflowId: overrides.workflowId } : {}),
          ...(overrides.workflowExecutionTimeout !== undefined
            ? { workflowExecutionTimeout: overrides.workflowExecutionTimeout }
            : {}),
          ...(overrides.workflowRunTimeout !== undefined
            ? { workflowRunTimeout: overrides.workflowRunTimeout }
            : {}),
          ...(overrides.workflowTaskTimeout !== undefined
            ? { workflowTaskTimeout: overrides.workflowTaskTimeout }
            : {}),
          ...(overrides.retry !== undefined ? { retry: overrides.retry } : {}),
          ...(overrides.memo !== undefined ? { memo: overrides.memo } : {}),
          ...(overrides.staticDetails !== undefined
            ? { staticDetails: overrides.staticDetails }
            : {}),
          ...(overrides.staticSummary !== undefined
            ? { staticSummary: overrides.staticSummary }
            : {}),
        };

        const handle = await this.scheduleClient.create({
          scheduleId: options.scheduleId,
          spec: options.spec,
          action,
          ...(options.policies !== undefined ? { policies: options.policies } : {}),
          ...(options.state !== undefined ? { state: options.state } : {}),
          ...(options.memo !== undefined ? { memo: options.memo } : {}),
        });
        return ok(wrapScheduleHandle(handle));
      } catch (error) {
        return err(new RuntimeClientError("schedule.create", error));
      }
    };
    return makeResultAsync(work);
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
      ResultAsync.fromPromise(
        handle.pause(note),
        (error) => new RuntimeClientError("schedule.pause", error),
      ).map(() => undefined),
    unpause: (note) =>
      ResultAsync.fromPromise(
        handle.unpause(note),
        (error) => new RuntimeClientError("schedule.unpause", error),
      ).map(() => undefined),
    trigger: (overlap) =>
      ResultAsync.fromPromise(
        handle.trigger(overlap),
        (error) => new RuntimeClientError("schedule.trigger", error),
      ).map(() => undefined),
    delete: () =>
      ResultAsync.fromPromise(
        handle.delete(),
        (error) => new RuntimeClientError("schedule.delete", error),
      ).map(() => undefined),
    describe: () =>
      ResultAsync.fromPromise(
        handle.describe(),
        (error) => new RuntimeClientError("schedule.describe", error),
      ),
  };
}
