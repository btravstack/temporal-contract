import type { ContractDefinition } from "@temporal-contract/contract";
import { TechnicalError } from "@temporal-contract/contract/errors";
import type {
  Backfill,
  ListScheduleOptions,
  ScheduleClient,
  ScheduleDescription,
  ScheduleHandle,
  ScheduleOptions,
  ScheduleOptionsStartWorkflowAction,
  ScheduleOverlapPolicy,
  ScheduleSummary,
  ScheduleUpdateOptions,
  Workflow,
} from "@temporalio/client";
import { TypedSearchAttributes } from "@temporalio/common";
import { type AsyncResult, OkAsync } from "unthrown";

import {
  type ScheduleAlreadyExistsError,
  type ScheduleNotFoundError,
  WorkflowValidationError,
} from "./errors.js";
import {
  call,
  classifyScheduleCreateError,
  classifyScheduleHandleError,
  lookupWorkflow,
  parseWithSchema,
  toTypedSearchAttributes,
  validateWorkflowInput,
} from "./internal.js";
import type { WorkflowArgsField } from "./options.js";
import type { TypedSearchAttributeMap } from "./types.js";

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
 * `scheduleId`, `spec`, `policies`, `state`, and `memo` are Temporal's own
 * schedule-level `ScheduleOptions`. `args` is typed against the destination
 * workflow's input schema (omittable when the schema accepts `undefined`).
 * Workflow-action–level overrides nest under {@link action} so memo and
 * other fields with the same name don't collide between the two scopes.
 */
export type TypedScheduleCreateOptions<
  TContract extends ContractDefinition,
  TWorkflowName extends keyof TContract["workflows"] & string,
> = ScheduleCreateFields &
  WorkflowArgsField<TContract["workflows"][TWorkflowName]> & {
    /**
     * Indexed search attributes for each workflow run spawned by this
     * schedule. Keys and value types are constrained to those declared on
     * the destination workflow's contract via `defineSearchAttribute`.
     * Translated to Temporal's `typedSearchAttributes` and attached to the
     * schedule's `startWorkflow` action so each spawned run is indexed
     * identically to one started directly via `client.startWorkflow`.
     */
    searchAttributes?: TypedSearchAttributeMap<TContract["workflows"][TWorkflowName]>;
  };

/** The workflow-independent fields of {@link TypedScheduleCreateOptions}. */
type ScheduleCreateFields = Pick<
  ScheduleOptions,
  "scheduleId" | "spec" | "policies" | "state" | "memo"
> & {
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
  /**
   * The underlying `@temporalio/client` `ScheduleHandle` — the escape hatch
   * for anything the typed surface doesn't cover. Calls made through `raw`
   * bypass contract validation.
   */
  readonly raw: ScheduleHandle;
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
   * the bound contract, the action is re-checked before anything is
   * persisted, the same way `create` checks it: its `args` against the
   * workflow's input schema (a mismatch is {@link WorkflowValidationError}
   * on the Err channel), and its `typedSearchAttributes` against the
   * declared attributes and kinds, and its `taskQueue` against the
   * contract's (either mismatch is a misconfiguration, so a defect). The
   * schedule is left untouched on any of them. An action whose
   * `workflowType` is NOT declared on the contract is persisted as-is
   * (passthrough — the contract has no schema to check it against); prefer
   * delete + `create` for contract-level changes.
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
  ): AsyncResult<TypedScheduleHandle, WorkflowValidationError | ScheduleAlreadyExistsError> {
    // Widen once at the boundary: `args` is a conditional field.
    const { args, searchAttributes, action, ...scheduleOptions } =
      options as ScheduleCreateFields & {
        args?: unknown;
        searchAttributes?: Record<string, unknown>;
      };
    return validateWorkflowInput(this.contract, workflowName, args, searchAttributes).flatMap(
      ({ typedSearchAttributes }) =>
        call(
          "schedule.create",
          this.scheduleClient.create({
            ...scheduleOptions,
            action: {
              ...action,
              // Contract-owned fields last, so the overrides can't move them.
              type: "startWorkflow",
              workflowType: workflowName,
              taskQueue: this.contract.taskQueue,
              // Original args on the wire — parsed by the worker when each
              // run starts. An omitted payload travels as empty args.
              args: args === undefined ? [] : [args],
              // Workflow-level indexing on the action (not the schedule), so
              // schedule-spawned runs share visibility with direct starts.
              ...(typedSearchAttributes ? { typedSearchAttributes } : {}),
            },
          }),
          (error) => classifyScheduleCreateError(error, options.scheduleId),
        ).map((handle) => wrapScheduleHandle(handle, this.contract)),
    );
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
   * List schedules in the namespace — a passthrough of Temporal's
   * `ScheduleClient.list`. Not filtered to this contract: Temporal's
   * visibility API lists every schedule the namespace knows about (use a
   * `query` option to narrow server-side).
   *
   * The one method outside the Result discipline: a lazy, paginated
   * `AsyncIterable` has no single outcome to carry, so a page fetch that
   * fails **throws** from the `for await` loop, exactly as Temporal's does.
   * Wrap the loop in your own boundary (`fromPromise`) when you need it as
   * an `AsyncResult`.
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
  const classify = (error: unknown) => classifyScheduleHandleError(error, handle.scheduleId);
  return {
    scheduleId: handle.scheduleId,
    raw: handle,
    pause: (note) => call("schedule.pause", handle.pause(note), classify),
    unpause: (note) => call("schedule.unpause", handle.unpause(note), classify),
    trigger: (overlap) => call("schedule.trigger", handle.trigger(overlap), classify),
    update: (updateFn) =>
      // Fetch the current description here (rather than inside Temporal's
      // own `update`) so the computed options can be checked with the same
      // async schema machinery as `create` BEFORE anything persists.
      call("schedule.update", handle.describe(), classify)
        .flatMap((previous) => {
          // A throwing updateFn is a caller bug — the flatMap net turns it
          // into a defect, matching the raw SDK's rejection shape.
          const updated = updateFn(previous);
          // Temporal's action accepts a workflow *function* beside a string
          // type name; a declared contract workflow is always addressed by
          // its string name (that's how `create` writes it).
          const workflowType = updated.action?.workflowType;
          if (
            typeof workflowType !== "string" ||
            !Object.hasOwn(contract.workflows, workflowType)
          ) {
            // Action doesn't target a declared contract workflow — the
            // contract has no schema to check it against, so persist as-is
            // (documented passthrough).
            return OkAsync(updated);
          }
          const definition = lookupWorkflow(contract, workflowType);
          if (updated.action.taskQueue !== contract.taskQueue) {
            // oxlint-disable-next-line unthrown/no-throw -- defect-channel routing: moving a contract workflow off the contract's queue is a misconfiguration; this throw inside flatMap becomes a defect
            throw new TechnicalError(
              `schedule.update: workflow "${workflowType}" must stay on the contract's task queue ` +
                `"${contract.taskQueue}", got "${updated.action.taskQueue}".`,
            );
          }
          // Same checks as `create`: declared attributes with matching kinds
          // (a mismatch throws → defect)…
          const attributes = updated.action.typedSearchAttributes;
          const pairs =
            attributes instanceof TypedSearchAttributes ? attributes.getAll() : (attributes ?? []);
          toTypedSearchAttributes(
            definition,
            workflowType,
            Object.fromEntries(pairs.map(({ key, value }) => [key.name, value])),
          );
          // …and the args against the input schema; the ORIGINAL args are
          // persisted (the worker parses each run's input on receive).
          return parseWithSchema(
            definition.input,
            updated.action.args?.[0],
            (issues) => new WorkflowValidationError(workflowType, "input", issues),
          ).map(() => updated);
        })
        .flatMap((updated) =>
          call(
            "schedule.update",
            handle.update(() => updated),
            classify,
          ),
        ),
    backfill: (options) => call("schedule.backfill", handle.backfill(options), classify),
    delete: () => call("schedule.delete", handle.delete(), classify),
    describe: () => call("schedule.describe", handle.describe(), classify),
  };
}
