import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  AnyWorkflowDefinition,
  InferUpdateNames,
  UpdateDefinition,
} from "@temporal-contract/contract";
import type { WorkflowHandle, WorkflowUpdateHandle } from "@temporalio/client";
import { type AsyncResult, Err, OkAsync, P } from "unthrown";

import {
  WORKFLOW_CANCELLED_ERROR_TAG,
  WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG,
  WORKFLOW_FAILED_ERROR_TAG,
  WORKFLOW_TERMINATED_ERROR_TAG,
  WORKFLOW_TIMEOUT_ERROR_TAG,
} from "./error-tags.js";
import {
  type QueryFailedError,
  type UpdateFailedError,
  type UpdateRejectedError,
  type UpdateRpcTimeoutOrCancelledError,
  type WorkflowExecutionNotFoundError,
  type WorkflowFailedError,
  QueryValidationError,
  SignalValidationError,
  UpdateValidationError,
  WorkflowValidationError,
} from "./errors.js";
import {
  call,
  classifyHandleError,
  classifyQueryError,
  classifyResultError,
  classifyUpdateError,
  classifyUpdateRpcError,
  lookupDeclared,
  type OnRehydrationMiss,
  parseWithSchema,
  rehydrateFailedResult,
} from "./internal.js";
import type { TypedStartUpdateOptions } from "./options.js";
import type {
  ClientInferInput,
  ClientInferOutput,
  ClientInferWorkflowQueries,
  ClientInferWorkflowSignals,
  ClientInferWorkflowUpdates,
  WorkflowContractErrorsOf,
  WorkflowResultErrorsOf,
} from "./types.js";

/**
 * Union of the modeled errors awaiting an update's outcome can surface:
 * output validation, a worker-side admission rejection, a failed (admitted)
 * handler, a timed-out/cancelled update call, or a missing execution.
 */
type UpdateResultError =
  | UpdateValidationError
  | UpdateRejectedError
  | UpdateFailedError
  | UpdateRpcTimeoutOrCancelledError
  | WorkflowExecutionNotFoundError;

/**
 * Union of the modeled errors {@link TypedWorkflowHandle.startUpdate} can
 * surface. Narrower than the update's outcome errors: Temporal hands back an
 * update handle for a rejected update too, so admission rejections and
 * handler failures only surface on the update handle's `result()`.
 */
type StartUpdateError =
  | UpdateValidationError
  | UpdateRpcTimeoutOrCancelledError
  | WorkflowExecutionNotFoundError;

/** The declared update definition named `TUpdateName`, or `never`. */
export type UpdateOf<
  TWorkflow extends AnyWorkflowDefinition,
  TUpdateName,
> = TUpdateName extends keyof TWorkflow["updates"]
  ? TWorkflow["updates"][TUpdateName] extends UpdateDefinition
    ? TWorkflow["updates"][TUpdateName]
    : never
  : never;

/**
 * Typed handle to an update, returned by
 * {@link TypedWorkflowHandle.startUpdate} and
 * {@link TypedWorkflowHandle.getUpdateHandle}. `result()` parses the
 * update's outcome against the contract's output schema on receive (the
 * worker transmits its original return value).
 */
export type TypedWorkflowUpdateHandle<TUpdate extends UpdateDefinition> = {
  /** The ID of this update request. */
  readonly updateId: string;
  /** The ID of the workflow execution targeted by this update. */
  readonly workflowId: string;
  /** The run ID of the targeted execution, when known. */
  readonly workflowRunId: string | undefined;
  /**
   * Wait for and return the update's result, parsed against the contract's
   * output schema. A worker-side admission rejection surfaces here as
   * `UpdateRejectedError`, a failed (admitted) handler as
   * `UpdateFailedError` — both on the Err channel, never as defects.
   */
  result: () => AsyncResult<ClientInferOutput<TUpdate>, UpdateResultError>;
};

/**
 * Typed workflow handle returned by `signalWithStart`. Adds `signaledRunId`
 * to the standard handle so callers can correlate the signal with the
 * (possibly pre-existing) workflow execution chain.
 */
export type TypedWorkflowHandleWithSignaledRunId<TWorkflow extends AnyWorkflowDefinition> =
  TypedWorkflowHandle<TWorkflow> & {
    /**
     * The Run Id of the bound Workflow at the time of `signalWithStart`. Since
     * `signalWithStart` may have signaled an existing Workflow Chain, this is
     * not necessarily the `firstExecutionRunId`.
     */
    readonly signaledRunId: string;
  };

/**
 * Typed workflow handle with validated results using unthrown Result/AsyncResult
 */
export type TypedWorkflowHandle<TWorkflow extends AnyWorkflowDefinition> = {
  readonly workflowId: string;

  /**
   * Run ID of the execution this handle is pinned to: the caller-provided
   * `runId` for `getHandle` handles, `undefined` otherwise — a started
   * handle follows its run chain (a continue-as-new moves it to the next
   * run), so it is not pinned to the run it started. See
   * {@link firstExecutionRunId} for the run a start created.
   */
  readonly runId: string | undefined;

  /**
   * Run ID of the first execution in the workflow chain, when known (set on
   * handles returned by `startWorkflow`, and on `getHandle` handles when the
   * caller passed `firstExecutionRunId`).
   */
  readonly firstExecutionRunId: string | undefined;

  /**
   * The underlying `@temporalio/client` `WorkflowHandle` — the escape hatch
   * for anything the typed surface doesn't cover yet (e.g. `raw.cancel()`
   * with SDK-specific options). Calls made through `raw` bypass contract
   * validation. Mirrors {@link TypedClient.raw} at the handle level.
   */
  readonly raw: WorkflowHandle;

  /**
   * Type-safe queries based on workflow definition with Result pattern.
   * Each query returns an `AsyncResult` — erring with `QueryValidationError`
   * (payload/result schema mismatch), `QueryFailedError` (no handler
   * registered on the execution, the handler threw, or the query was
   * rejected), or `WorkflowExecutionNotFoundError` — instead of a throwing
   * `Promise`; the error union is carried by
   * {@link ClientInferWorkflowQueries} directly.
   */
  queries: ClientInferWorkflowQueries<TWorkflow>;

  /**
   * Type-safe signals based on workflow definition with Result pattern.
   * Each signal returns an `AsyncResult` — erring with
   * `SignalValidationError` or `WorkflowExecutionNotFoundError` — instead of
   * a throwing `Promise`; the error union is carried by
   * {@link ClientInferWorkflowSignals} directly.
   */
  signals: ClientInferWorkflowSignals<TWorkflow>;

  /**
   * Type-safe updates based on workflow definition with Result pattern.
   * Each update starts the update AND waits for its result (Temporal's
   * `executeUpdate`) — `updates.name(input, { updateId })` — returning an
   * `AsyncResult` that errs with `UpdateValidationError`,
   * `UpdateRejectedError` (worker-side admission rejection),
   * `UpdateFailedError` (the admitted handler failed),
   * `UpdateRpcTimeoutOrCancelledError`, or `WorkflowExecutionNotFoundError`;
   * use {@link startUpdate} to obtain an update handle without waiting for
   * completion.
   */
  updates: ClientInferWorkflowUpdates<TWorkflow>;

  /**
   * Start an update without waiting for its completion — Temporal's
   * `startUpdate` beside the `updates` map's execute-and-wait shape. The
   * update is addressed positionally (`startUpdate(updateName, options)`);
   * everything else rides the {@link TypedStartUpdateOptions} bag. The
   * `options` parameter is omittable when the update's input schema accepts
   * `undefined` (e.g. an argument-less `defineUpdate({ output })`).
   *
   * Returns a {@link TypedWorkflowUpdateHandle} once the update is accepted
   * **or rejected**: a worker-side admission rejection (and a failed
   * handler) surfaces on the update handle's `result()`, not here.
   */
  startUpdate: <TUpdateName extends InferUpdateNames<TWorkflow>>(
    updateName: TUpdateName,
    ...options: undefined extends ClientInferInput<UpdateOf<TWorkflow, TUpdateName>>
      ? [options?: TypedStartUpdateOptions<UpdateOf<TWorkflow, TUpdateName>>]
      : [options: TypedStartUpdateOptions<UpdateOf<TWorkflow, TUpdateName>>]
  ) => AsyncResult<TypedWorkflowUpdateHandle<UpdateOf<TWorkflow, TUpdateName>>, StartUpdateError>;

  /**
   * Reattach to an update already sent to this execution, by its
   * `updateId` — Temporal's `getUpdateHandle`, typed against the named
   * update so `result()` parses the outcome against its output schema.
   * Synchronous, like Temporal's: nothing is sent until `result()`.
   */
  getUpdateHandle: <TUpdateName extends InferUpdateNames<TWorkflow>>(
    updateName: TUpdateName,
    updateId: string,
  ) => TypedWorkflowUpdateHandle<UpdateOf<TWorkflow, TUpdateName>>;

  /**
   * Get workflow result with Result pattern. When the workflow declares
   * contract errors, a failed execution whose failure matches a declared
   * error surfaces as that typed error instead of the generic
   * {@link WorkflowFailedError}. A cancelled / terminated / timed-out
   * execution surfaces as the first-class `WorkflowCancelledError` /
   * `WorkflowTerminatedError` / `WorkflowTimeoutError` — no `instanceof`
   * digging through `WorkflowFailedError.cause` required. Cancellation is a
   * modeled `Err(...)`: give it its own matcher arm rather than folding it
   * into a blanket "failed" branch, so a deliberate cancel isn't reported
   * as a breakage.
   */
  result: () => AsyncResult<ClientInferOutput<TWorkflow>, WorkflowResultErrorsOf<TWorkflow>>;

  /**
   * Terminate workflow with Result pattern
   */
  terminate: (reason?: string) => AsyncResult<void, WorkflowExecutionNotFoundError>;

  /**
   * Cancel workflow with Result pattern
   */
  cancel: () => AsyncResult<void, WorkflowExecutionNotFoundError>;

  /**
   * Get workflow execution description including status and metadata
   */
  describe: () => AsyncResult<
    Awaited<ReturnType<WorkflowHandle["describe"]>>,
    WorkflowExecutionNotFoundError
  >;

  /**
   * Fetch the workflow execution history
   */
  fetchHistory: () => AsyncResult<
    Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>,
    WorkflowExecutionNotFoundError
  >;
};

/**
 * Await an update outcome and parse it against the update's output schema —
 * the receive side of the update-result boundary, shared by update handles
 * and `executeUpdateWithStart`. `classify` recognizes the call's modeled
 * rejections; anything else is a defect.
 */
export function updateOutcome<E>(
  operation: string,
  outcome: Promise<unknown>,
  updateName: string,
  updateDef: UpdateDefinition,
  classify: (error: unknown) => E | undefined,
): AsyncResult<unknown, E | UpdateValidationError> {
  return call(operation, outcome, classify).flatMap((raw) =>
    parseWithSchema(
      updateDef.output,
      raw,
      (issues) => new UpdateValidationError(updateName, "output", issues),
    ),
  );
}

/**
 * Validate an update's input before it is sent. The parsed value is
 * discarded: the original input crosses the wire, and the update handler
 * parses on receive.
 */
export function validateUpdateInput(
  updateName: string,
  updateDef: UpdateDefinition,
  input: unknown,
): AsyncResult<unknown, UpdateValidationError> {
  return parseWithSchema(
    updateDef.input,
    input,
    (issues) => new UpdateValidationError(updateName, "input", issues),
  );
}

/** Temporal's update args: an omitted payload travels as empty args. */
export function updateArgs(input: unknown): [unknown] {
  return (input === undefined ? [] : [input]) as [unknown];
}

/**
 * Wrap a Temporal `WorkflowHandle` in the typed, validating surface.
 *
 * @internal — built by `ContractClient`; not part of the public API.
 */
export function createTypedHandle<TWorkflow extends AnyWorkflowDefinition>(
  workflowHandle: WorkflowHandle,
  workflowName: string,
  definition: TWorkflow,
  ids: { runId?: string | undefined; firstExecutionRunId?: string | undefined },
  onRehydrationMiss: OnRehydrationMiss | undefined,
): TypedWorkflowHandle<TWorkflow> {
  const workflowId = workflowHandle.workflowId;
  const updateDefs = definition.updates as Record<string, UpdateDefinition> | undefined;
  const lookupUpdate = (updateName: string): UpdateDefinition =>
    lookupDeclared(updateDefs, updateName, "Update", `workflow "${workflowName}"`);

  const queries = buildValidatedProxy({
    defs: definition.queries,
    operation: "query",
    makeValidationError: (name, direction, issues) =>
      new QueryValidationError(name, direction, issues),
    invoke: (name, input) =>
      input === undefined ? workflowHandle.query(name) : workflowHandle.query(name, input),
    validateOutput: (def) => def.output,
    // An unregistered handler / a throwing query handler is a routine
    // operational outcome, modeled beside the missing execution.
    classifyError: (error, name) =>
      classifyHandleError(error, workflowId) ?? classifyQueryError(error, name),
  }) as TypedWorkflowHandle<TWorkflow>["queries"];

  const signals = buildValidatedProxy({
    defs: definition.signals,
    operation: "signal",
    makeValidationError: (name, _direction, issues) => new SignalValidationError(name, issues),
    invoke: async (name, input) => {
      // A payload-less send travels as empty args, not `[undefined]`.
      if (input === undefined) {
        await workflowHandle.signal(name);
      } else {
        await workflowHandle.signal(name, input);
      }
      return undefined;
    },
    validateOutput: () => null,
    classifyError: (error) => classifyHandleError(error, workflowId),
  }) as TypedWorkflowHandle<TWorkflow>["signals"];

  const updates = buildValidatedProxy({
    defs: definition.updates,
    operation: "update",
    makeValidationError: (name, direction, issues) =>
      new UpdateValidationError(name, direction, issues),
    invoke: (name, input, options) =>
      workflowHandle.executeUpdate(name, { args: updateArgs(input), ...options }),
    validateOutput: (def) => def.output,
    // A rejected admission / failed handler is a routine business
    // failure, modeled beside the missing execution.
    classifyError: (error, name) =>
      classifyHandleError(error, workflowId) ?? classifyUpdateError(error, name),
  }) as TypedWorkflowHandle<TWorkflow>["updates"];

  const wrapUpdateHandle = (
    updateHandle: WorkflowUpdateHandle<unknown>,
    updateName: string,
    updateDef: UpdateDefinition,
  ): TypedWorkflowUpdateHandle<UpdateDefinition> => ({
    updateId: updateHandle.updateId,
    workflowId: updateHandle.workflowId,
    workflowRunId: updateHandle.workflowRunId,
    result: () =>
      // `result()` is invoked inside the combinator so a synchronous throw
      // from the SDK lands on the defect channel instead of escaping.
      OkAsync().flatMap(() =>
        updateOutcome(
          "update.result",
          updateHandle.result(),
          updateName,
          updateDef,
          (error) =>
            classifyHandleError(error, updateHandle.workflowId) ??
            classifyUpdateError(error, updateName),
        ),
      ),
  });

  const startUpdate = (
    updateName: string,
    options?: { args?: unknown; updateId?: string; waitForStage?: "ACCEPTED" },
  ): AsyncResult<TypedWorkflowUpdateHandle<UpdateDefinition>, StartUpdateError> =>
    OkAsync().flatMap(() => {
      const updateDef = lookupUpdate(updateName);
      return validateUpdateInput(updateName, updateDef, options?.args).flatMap(() =>
        call(
          "startUpdate",
          workflowHandle.startUpdate(updateName, {
            args: updateArgs(options?.args),
            waitForStage: options?.waitForStage ?? "ACCEPTED",
            ...(options?.updateId !== undefined ? { updateId: options.updateId } : {}),
          }),
          // SDK 1.24's start path never raises the update's outcome (see
          // `StartUpdateError`); only the call itself can fail.
          (error) =>
            classifyHandleError(error, workflowId) ?? classifyUpdateRpcError(error, updateName),
        ).map((updateHandle) => wrapUpdateHandle(updateHandle, updateName, updateDef)),
      );
    });

  const getUpdateHandle = (
    updateName: string,
    updateId: string,
  ): TypedWorkflowUpdateHandle<UpdateDefinition> =>
    wrapUpdateHandle(
      workflowHandle.getUpdateHandle(updateId),
      updateName,
      lookupUpdate(updateName),
    );

  return {
    workflowId,
    runId: ids.runId,
    firstExecutionRunId: ids.firstExecutionRunId,
    raw: workflowHandle,
    queries,
    signals,
    updates,
    startUpdate: startUpdate as TypedWorkflowHandle<TWorkflow>["startUpdate"],
    getUpdateHandle: getUpdateHandle as TypedWorkflowHandle<TWorkflow>["getUpdateHandle"],
    result: (): AsyncResult<ClientInferOutput<TWorkflow>, WorkflowResultErrorsOf<TWorkflow>> =>
      call("result", workflowHandle.result(), (error) => classifyResultError(error, workflowId))
        .flatMapErrCases((matcher) =>
          matcher
            // A failure matching one of the workflow's declared contract
            // errors rehydrates into the typed error; everything else
            // flows through unchanged. The cast narrows `AnyContractError`
            // to this workflow's precise declared-error union.
            .with(
              P.tag(WORKFLOW_FAILED_ERROR_TAG),
              (failed) =>
                rehydrateFailedResult(definition, failed, onRehydrationMiss) as AsyncResult<
                  never,
                  WorkflowContractErrorsOf<TWorkflow> | WorkflowFailedError
                >,
            )
            .with(
              P.tag(WORKFLOW_CANCELLED_ERROR_TAG),
              P.tag(WORKFLOW_TERMINATED_ERROR_TAG),
              P.tag(WORKFLOW_TIMEOUT_ERROR_TAG),
              P.tag(WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG),
              (error) => Err(error),
            ),
        )
        .flatMap(
          (result) =>
            // Receive side of the result boundary: the worker transmitted
            // its original return value, so the parse (and any schema
            // transform) happens exactly once, here.
            parseWithSchema(
              definition.output,
              result,
              (issues) => new WorkflowValidationError(workflowName, "output", issues, workflowId),
            ) as AsyncResult<ClientInferOutput<TWorkflow>, WorkflowValidationError>,
        ),
    terminate: (reason?: string) =>
      call("terminate", workflowHandle.terminate(reason), (error) =>
        classifyHandleError(error, workflowId),
      ).map(() => undefined),
    cancel: () =>
      call("cancel", workflowHandle.cancel(), (error) =>
        classifyHandleError(error, workflowId),
      ).map(() => undefined),
    describe: () =>
      call("describe", workflowHandle.describe(), (error) =>
        classifyHandleError(error, workflowId),
      ),
    fetchHistory: () =>
      call("fetchHistory", workflowHandle.fetchHistory(), (error) =>
        classifyHandleError(error, workflowId),
      ),
  };
}

type DefWithInput = { readonly input: StandardSchemaV1 };

/**
 * Union of the modeled operation errors the three handle proxies can
 * classify an invoke rejection into. The builder is typed against this
 * widened union (each call site's `classifyError` produces the relevant
 * subset); the public per-operation precision lives on the
 * `ClientInferSignal` / `ClientInferQuery` / `ClientInferUpdate` types the
 * proxies are cast to.
 */
type ProxyOperationError =
  | WorkflowExecutionNotFoundError
  | QueryFailedError
  | UpdateFailedError
  | UpdateRejectedError
  | UpdateRpcTimeoutOrCancelledError;

/** Per-call options a proxy forwards to `invoke` (only updates use any). */
type ProxyCallOptions = { readonly updateId?: string };

type ProxyOptions<TDef extends DefWithInput, TValidationError extends Error> = {
  readonly defs: Record<string, TDef> | undefined;
  /** Operation label carried into `RuntimeClientError` on an unclassified failure. */
  readonly operation: "signal" | "query" | "update";
  readonly makeValidationError: (
    name: string,
    direction: "input" | "output",
    issues: ReadonlyArray<StandardSchemaV1.Issue>,
  ) => TValidationError;
  /**
   * Dispatch the call to Temporal. Receives the caller's ORIGINAL input —
   * validated against the contract, but untransformed: the workflow-side
   * handler parses the payload on receive. An `undefined` input means the
   * caller omitted the payload; implementations send empty args.
   */
  readonly invoke: (name: string, input: unknown, options?: ProxyCallOptions) => Promise<unknown>;
  /**
   * Returns the schema to parse the invoke result against, or `null` to skip
   * output parsing (used by signals, which don't return a value).
   */
  readonly validateOutput: (def: TDef) => StandardSchemaV1 | null;
  /**
   * Recognize an `invoke` rejection as a modeled operation error (a missing
   * execution, a rejected update, an unregistered query, …). Returns
   * `undefined` for anything else — an unrecognized, technical failure the
   * proxy routes to the defect channel.
   */
  readonly classifyError: (error: unknown, name: string) => ProxyOperationError | undefined;
};

/**
 * Build a `{ name: (args, options?) => AsyncResult<...> }` proxy for a
 * contract's queries/signals/updates. The three call sites differ only in
 * how they invoke Temporal, whether they parse output, and how they classify
 * invoke rejections, so the shared input-validate → invoke(original) →
 * output-parse pipeline lives here once. Input validation only gates the
 * call — the original value is transmitted and the worker parses it — while
 * the result is parsed here on the receiving side.
 */
function buildValidatedProxy<TDef extends DefWithInput, TValidationError extends Error>({
  defs,
  operation,
  makeValidationError,
  invoke,
  validateOutput,
  classifyError,
}: ProxyOptions<TDef, TValidationError>): Record<
  string,
  (
    args?: unknown,
    options?: ProxyCallOptions,
  ) => AsyncResult<unknown, TValidationError | ProxyOperationError>
> {
  type ProxyError = TValidationError | ProxyOperationError;
  const proxy: Record<
    string,
    (args?: unknown, options?: ProxyCallOptions) => AsyncResult<unknown, ProxyError>
  > = {};
  if (!defs) return proxy;

  for (const [name, def] of Object.entries(defs)) {
    proxy[name] = (input, options) =>
      parseWithSchema(def.input, input, (issues) => makeValidationError(name, "input", issues))
        .flatMap(() =>
          call(operation, invoke(name, input, options), (error) => classifyError(error, name)),
        )
        .flatMap((result) => {
          const outputSchema = validateOutput(def);
          return outputSchema
            ? parseWithSchema(outputSchema, result, (issues) =>
                makeValidationError(name, "output", issues),
              )
            : OkAsync(result);
        });
  }

  return proxy;
}
