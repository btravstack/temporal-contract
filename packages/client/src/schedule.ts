import type { AnyWorkflowDefinition, ContractDefinition } from "@temporal-contract/contract";
import type {
  Backfill,
  ListScheduleOptions,
  ScheduleClient,
  ScheduleDescription,
  ScheduleHandle,
  ScheduleOptions,
  ScheduleOptionsStartWorkflowAction,
  ScheduleOverlapPolicy,
  ScheduleSpec,
  ScheduleSummary,
  ScheduleUpdateOptions,
  Workflow,
} from "@temporalio/client";
import { type AsyncResult, Ok, Err, OkAsync, fromPromise } from "unthrown";

import type { TypedSearchAttributeMap } from "./client.js";
import {
  RuntimeClientError,
  type ScheduleAlreadyExistsError,
  type ScheduleNotFoundError,
  WorkflowNotInContractError,
  WorkflowValidationError,
} from "./errors.js";
import {
  classifyScheduleCreateError,
  classifyScheduleHandleError,
  makeAsyncResult,
  toTypedSearchAttributes,
  validateStandardSchema,
} from "./internal.js";
import type { ClientInferInput } from "./types.js";

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
 * methods (`pause`, `unpause`, `trigger`, `update`, `backfill`, `describe`,
 * `delete`) wrapped in the unthrown AsyncResult pattern so call sites match
 * the rest of the typed client.
 *
 * Every method surfaces a missing schedule (Temporal's
 * `ScheduleNotFoundError` — wrong ID, or the schedule was deleted) as the
 * modeled {@link ScheduleNotFoundError} on the Err channel; any other
 * failure is a *technical* fault routed to the Defect channel with a
 * {@link RuntimeClientError} cause.
 */
export type TypedScheduleHandle = {
  /** This schedule's identifier. */
  readonly scheduleId: string;
  /** Pause the schedule. Optional note becomes part of the audit trail. */
  pause: (note?: string) => AsyncResult<void, ScheduleNotFoundError>;
  /** Resume a paused schedule. */
  unpause: (note?: string) => AsyncResult<void, ScheduleNotFoundError>;
  /** Fire the schedule's action immediately. */
  trigger: (overlap?: ScheduleOverlapPolicy) => AsyncResult<void, ScheduleNotFoundError>;
  /**
   * Update the schedule definition: the handle fetches the current
   * description, hands it to `updateFn`, and persists the returned options.
   *
   * When the returned action's `workflowType` names a workflow declared on
   * the bound contract, the action's `args` are validated against that
   * workflow's input schema before anything is persisted — a mismatch
   * surfaces as {@link WorkflowValidationError} on the Err channel and the
   * schedule is left untouched. An action whose `workflowType` is NOT
   * declared on the contract is persisted as-is (passthrough — the contract
   * has no schema to check it against); prefer delete + `create` for
   * contract-level changes.
   *
   * Concurrency: **last writer wins.** Temporal's `UpdateSchedule` RPC is
   * unconditional — the TypeScript SDK sends no conflict token and does not
   * re-run `updateFn` on a conflict — so a concurrent modification landing
   * between the read and the write is overwritten. That is true of the raw
   * SDK too; this wrapper does not weaken it, but it does widen the window
   * slightly: validation is asynchronous (schemas may be), so the wrapper
   * fetches the description itself and hands the *already-computed* options
   * to `ScheduleHandle.update`, which describes again internally. `updateFn`
   * is invoked exactly once per call, and the options that are validated are
   * exactly the options that are persisted.
   *
   * If two writers can race on one schedule, serialize them yourself.
   */
  update: (
    updateFn: (
      previous: ScheduleDescription,
    ) => ScheduleUpdateOptions<ScheduleOptionsStartWorkflowAction<Workflow>>,
  ) => AsyncResult<void, ScheduleNotFoundError | WorkflowValidationError>;
  /**
   * Run the schedule's action for historical time ranges, as if the
   * schedule had been active over them. Passthrough of Temporal's
   * `ScheduleHandle.backfill`.
   */
  backfill: (options: Backfill | Backfill[]) => AsyncResult<void, ScheduleNotFoundError>;
  /** Delete the schedule. */
  delete: () => AsyncResult<void, ScheduleNotFoundError>;
  /** Fetch the schedule's current description from the server. */
  describe: () => AsyncResult<ScheduleDescription, ScheduleNotFoundError>;
};

/**
 * Typed wrapper around Temporal's `ScheduleClient`. Exposed as
 * `contractClient.schedule` — keeps the typed-client surface organized the
 * same way Temporal's own `Client.schedule` does. Not constructible
 * directly: the class is exported for type annotations only.
 */
export class TypedScheduleClient<TContract extends ContractDefinition> {
  private constructor(
    private readonly contract: TContract,
    private readonly scheduleClient: ScheduleClient,
  ) {}

  /**
   * Constructed exclusively by `ContractClient` (itself handed out by
   * `TypedClient.for`). Not part of the public API — reach instances via
   * `typedClient.for(contract).schedule`.
   *
   * @internal
   */
  static _internal_create<TContract extends ContractDefinition>(
    contract: TContract,
    scheduleClient: ScheduleClient,
  ): TypedScheduleClient<TContract> {
    return new TypedScheduleClient(contract, scheduleClient);
  }

  /**
   * Create a new schedule that, on each fire, starts the named contract
   * workflow with validated args.
   *
   * Validates `args` against the workflow's input schema before dispatching
   * the create request to Temporal — but transmits the caller's ORIGINAL
   * args (the worker parses them when each scheduled run starts, so a
   * transforming schema applies exactly once, on the receiving side). The
   * workflow's `taskQueue` and `workflowType` are pulled from the contract
   * automatically; the typed options shape omits them so call sites don't
   * have to repeat themselves.
   *
   * A colliding running schedule (same `scheduleId`, not deleted) surfaces
   * as {@link ScheduleAlreadyExistsError} on the Err channel.
   */
  create<TWorkflowName extends keyof TContract["workflows"] & string>(
    workflowName: TWorkflowName,
    options: TypedScheduleCreateOptions<TContract, TWorkflowName>,
  ): AsyncResult<
    TypedScheduleHandle,
    WorkflowNotInContractError | WorkflowValidationError | ScheduleAlreadyExistsError
  > {
    type CreateOk = TypedScheduleHandle;
    type CreateErr =
      | WorkflowNotInContractError
      | WorkflowValidationError
      | ScheduleAlreadyExistsError;
    const work = async () => {
      const definition = this.contract.workflows[workflowName];
      if (!definition) {
        return Err(
          new WorkflowNotInContractError(workflowName, Object.keys(this.contract.workflows)),
        );
      }

      const inputResult = await definition.input["~standard"].validate(options.args);
      if (inputResult.issues) {
        return Err(new WorkflowValidationError(workflowName, "input", inputResult.issues));
      }

      // Translate typed search attributes for the spawned workflow runs.
      // Lives on the schedule's `startWorkflow` action (workflow-level
      // indexing), not on the schedule itself. Mirrors what
      // `client.startWorkflow` does for direct starts so schedule-spawned
      // runs share visibility with their direct-start counterparts.
      // `toTypedSearchAttributes` throws a `RuntimeClientError` on an
      // undeclared key — a technical misconfiguration routed to the defect
      // channel by the enclosing `makeAsyncResult` work thunk.
      const typedSearchAttributes = toTypedSearchAttributes(
        definition,
        workflowName,
        options.searchAttributes as Record<string, unknown> | undefined,
      );

      try {
        const overrides = options.action ?? {};
        const action: ScheduleOptionsStartWorkflowAction<never> = {
          type: "startWorkflow",
          workflowType: workflowName,
          taskQueue: this.contract.taskQueue,
          // Original args on the wire — validated above, parsed by the
          // worker when each run starts (D1).
          args: [options.args] as never,
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
        return Ok(wrapScheduleHandle(handle, this.contract));
      } catch (error) {
        const alreadyExists = classifyScheduleCreateError(error, options.scheduleId);
        if (alreadyExists) return Err(alreadyExists);
        // Unrecognized, technical failure — route to the defect channel.
        // oxlint-disable-next-line unthrown/no-throw -- defect-channel routing: this throw inside the makeAsyncResult work thunk IS how a technical fault becomes a defect, never a modeled Err
        throw new RuntimeClientError("schedule.create", error);
      }
    };
    return makeAsyncResult<CreateOk, CreateErr>(work);
  }

  /**
   * Get a typed handle to an existing schedule. Does not validate that the
   * schedule exists — handle methods (`describe`, `pause`, etc.) surface a
   * {@link ScheduleNotFoundError} if the underlying ID is unknown.
   */
  getHandle(scheduleId: string): TypedScheduleHandle {
    return wrapScheduleHandle(this.scheduleClient.getHandle(scheduleId), this.contract);
  }

  /**
   * List schedules in the namespace — a typed async-iterable passthrough of
   * Temporal's `ScheduleClient.list`. Not filtered to this contract:
   * Temporal's visibility API lists every schedule the namespace knows
   * about (use a `query` option to narrow server-side).
   */
  list(options?: ListScheduleOptions): AsyncIterable<ScheduleSummary> {
    return this.scheduleClient.list(options);
  }
}

function wrapScheduleHandle(
  handle: ScheduleHandle,
  contract: ContractDefinition,
): TypedScheduleHandle {
  // Every lifecycle method shares the classify-or-defect tail: a missing
  // schedule is the modeled Err; anything else rides the defect channel.
  return {
    scheduleId: handle.scheduleId,
    pause: (note) =>
      fromPromise(
        handle.pause(note),
        (error, defect) =>
          classifyScheduleHandleError(error, handle.scheduleId) ??
          defect(new RuntimeClientError("schedule.pause", error)),
      ).map(() => undefined),
    unpause: (note) =>
      fromPromise(
        handle.unpause(note),
        (error, defect) =>
          classifyScheduleHandleError(error, handle.scheduleId) ??
          defect(new RuntimeClientError("schedule.unpause", error)),
      ).map(() => undefined),
    trigger: (overlap) =>
      fromPromise(
        handle.trigger(overlap),
        (error, defect) =>
          classifyScheduleHandleError(error, handle.scheduleId) ??
          defect(new RuntimeClientError("schedule.trigger", error)),
      ).map(() => undefined),
    update: (updateFn) =>
      // Fetch the current description here (rather than inside Temporal's
      // own `update`) so the computed options can be validated with the
      // same async schema machinery as `create` BEFORE anything persists.
      fromPromise(
        handle.describe(),
        (error, defect) =>
          classifyScheduleHandleError(error, handle.scheduleId) ??
          defect(new RuntimeClientError("schedule.update", error)),
      )
        .flatMap((previous) => {
          // A throwing updateFn is a caller bug — the flatMap net turns it
          // into a defect, matching the raw SDK's rejection shape.
          const updated = updateFn(previous);
          // Temporal's action accepts a workflow *function* beside a string
          // type name; a declared contract workflow is always addressed by
          // its string name (that's how `create` writes it).
          const workflowType = updated.action?.workflowType;
          const workflowDef =
            typeof workflowType === "string"
              ? (contract.workflows[workflowType] as AnyWorkflowDefinition | undefined)
              : undefined;
          if (!workflowDef) {
            // Action doesn't target a declared contract workflow — the
            // contract has no schema to check it against, so persist as-is
            // (documented passthrough).
            return OkAsync(updated);
          }
          // Same machinery as `create`: async-validate the action's args
          // against the declared workflow's input schema, fail early with
          // the same typed error, and transmit the ORIGINAL args (D1).
          return validateStandardSchema(workflowDef.input, updated.action.args?.[0]).flatMap(
            (inputResult) =>
              inputResult.issues
                ? Err(
                    new WorkflowValidationError(
                      workflowType as string,
                      "input",
                      inputResult.issues,
                    ),
                  )
                : Ok(updated),
          );
        })
        .flatMap((updated) =>
          fromPromise(
            handle.update(() => updated),
            (error, defect) =>
              classifyScheduleHandleError(error, handle.scheduleId) ??
              defect(new RuntimeClientError("schedule.update", error)),
          ),
        )
        .map(() => undefined),
    backfill: (options) =>
      fromPromise(
        handle.backfill(options),
        (error, defect) =>
          classifyScheduleHandleError(error, handle.scheduleId) ??
          defect(new RuntimeClientError("schedule.backfill", error)),
      ).map(() => undefined),
    delete: () =>
      fromPromise(
        handle.delete(),
        (error, defect) =>
          classifyScheduleHandleError(error, handle.scheduleId) ??
          defect(new RuntimeClientError("schedule.delete", error)),
      ).map(() => undefined),
    describe: () =>
      fromPromise(
        handle.describe(),
        (error, defect) =>
          classifyScheduleHandleError(error, handle.scheduleId) ??
          defect(new RuntimeClientError("schedule.describe", error)),
      ),
  };
}
