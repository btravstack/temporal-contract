/**
 * Internal helpers shared across the worker package's entry points.
 *
 * Not part of the public API — this module is not listed in the package's
 * `exports` map, so consumers can't import from `@temporal-contract/worker/internal`.
 * In-package tests import it directly via relative path.
 */
import { isCancellation, makeContinueAsNewFunc, proxyActivities } from "@temporalio/workflow";
import type { ActivityOptions, ContinueAsNewOptions } from "@temporalio/workflow";
import { ChildWorkflowFailure } from "@temporalio/common";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type ActivityDefinition,
  type ContractDefinition,
  summarizeIssues,
} from "@temporal-contract/contract";
import {
  ChildWorkflowCancelledError,
  ChildWorkflowError,
  WorkflowInputValidationError,
} from "./errors.js";

/**
 * Build the message attached to a `ChildWorkflowError` for input/output
 * validation failures. Centralized so the worker formats child-workflow
 * validation diagnostics identically across call sites. Composes the shared
 * `summarizeIssues` from `@temporal-contract/contract`.
 */
export function formatChildWorkflowValidationMessage(
  workflowName: string,
  direction: "input" | "output",
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): string {
  return `Child workflow "${workflowName}" ${direction} validation failed: ${summarizeIssues(issues)}`;
}

// Re-export the shared `_internal_makeAsyncResult` helper from the contract
// package so worker call sites can wrap their `() => Promise<Result<T, E>>`
// work functions identically to the client side. Unanticipated rejections
// (a synchronous throw or a rejected promise from `work()`) are routed through
// unthrown's `defect` channel rather than escaping as an unhandled rejection.
// `assertNoDefect` narrows an internally-built `Result` (known to carry only
// ok/err) to `Ok | Err`, re-throwing a stray defect's cause — so call sites
// reach `.value` / `.error` without a manual "impossible defect" guard.
export {
  _internal_makeAsyncResult as makeAsyncResult,
  _internal_assertNoDefect as assertNoDefect,
} from "@temporal-contract/contract/result-async";

/**
 * Extract the single payload from a Temporal handler's `...args` array.
 *
 * Temporal invokes handlers with whatever was passed via `args: [...]` at the
 * call site. The typed-contract layer always sends `args: [validatedInput]`,
 * so the common case is a one-element array containing the wrapped input.
 *
 * If a non-typed-contract caller passes multiple positional arguments
 * (`args: [a, b, c]`), we surface the whole array as the input — the schema
 * will then reject it unless the contract specifically modeled a tuple.
 */
export function extractHandlerInput(args: unknown[]): unknown {
  return args.length === 1 ? args[0] : args;
}

type ActivityFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Build the raw `Record<name, fn>` proxy of activities for a workflow,
 * applying per-activity `ActivityOptions` overrides where requested.
 *
 * **Fast path (no overrides):** a single `proxyActivities(defaultOptions)`
 * call is made and returned directly. The proxy synthesizes a function for
 * any property access by name, so downstream code that looks up
 * `proxy[activityName]` works identically to before.
 *
 * **Override path:** one extra `proxyActivities(merged)` call is made *only*
 * for each activity that has an override. Activities without an entry keep
 * using the single default proxy. The result is a `Proxy` that returns the
 * override-bound function for named keys and falls back to the default proxy
 * for everything else — so the per-execution overhead scales with the number
 * of overrides, not the number of activities.
 *
 * Per-override merge is shallow: the override's properties replace the
 * default's, including the entire nested `retry` block. This matches
 * Temporal's "one ActivityOptions per `proxyActivities` call" semantics.
 */
export function buildRawActivitiesProxy(
  workflowActivities: Record<string, ActivityDefinition> | undefined,
  contractActivities: Record<string, ActivityDefinition> | undefined,
  defaultOptions: ActivityOptions,
  overrides: Partial<Record<string, ActivityOptions>> | undefined,
): Record<string, ActivityFn> {
  const defaultProxy = proxyActivities<Record<string, ActivityFn>>(defaultOptions);

  // Fast path: no overrides → use the single default proxy directly.
  // (`createValidatedActivities` accesses by name, so the Proxy's get-trap
  // suffices; we don't need an enumerable map.)
  const overrideEntries = overrides
    ? Object.entries(overrides).filter(
        (entry): entry is [string, ActivityOptions] => entry[1] !== undefined,
      )
    : [];
  if (overrideEntries.length === 0) {
    return defaultProxy;
  }

  // Validate every override key corresponds to a declared activity.
  // Without this, a typo at runtime (or a stale options bag from a renamed
  // activity) silently builds a proxy for a non-existent activity.
  const declared = new Set<string>([
    ...Object.keys(workflowActivities ?? {}),
    ...Object.keys(contractActivities ?? {}),
  ]);
  for (const [name] of overrideEntries) {
    if (!declared.has(name)) {
      throw new Error(
        `activityOptionsByName entry "${name}" does not match any declared activity. Available: ${[...declared].join(", ") || "none"}.`,
      );
    }
  }

  // Override path: build one proxy per override; combine with the default
  // proxy via a get-trap so unmatched keys still get the default options.
  const overriddenFns: Record<string, ActivityFn> = {};
  for (const [name, override] of overrideEntries) {
    const mergedOptions: ActivityOptions = { ...defaultOptions, ...override };
    const overrideProxy = proxyActivities<Record<string, ActivityFn>>(mergedOptions);
    const fn = overrideProxy[name];
    if (fn !== undefined) {
      overriddenFns[name] = fn;
    }
  }

  return new Proxy(overriddenFns, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      return target[prop] ?? defaultProxy[prop];
    },
  });
}

/**
 * Continue-as-new options the typed wrapper does not own. `workflowType` and
 * `taskQueue` are derived from the contract; everything else is forwarded to
 * Temporal's `makeContinueAsNewFunc`.
 */
export type TypedContinueAsNewOptions = Omit<ContinueAsNewOptions, "workflowType" | "taskQueue">;

/**
 * Build the typed `continueAsNew` function bound to the running workflow's
 * contract. Two overloads — same-workflow and cross-contract — share one
 * implementation; the public type signature lives on `WorkflowContext` so
 * call sites are type-safe.
 *
 * Validation runs *before* Temporal's `makeContinueAsNewFunc(...)` is invoked.
 * On failure, throws a `WorkflowInputValidationError` (matching the behaviour
 * of `declareWorkflow`'s incoming-input validation), which surfaces back to
 * Temporal as a workflow failure rather than silently proceeding with an
 * invalid run.
 *
 * Temporal's `continueAsNew` never returns — it throws a `ContinueAsNew`
 * exception that the runtime intercepts. The returned function preserves
 * `Promise<never>` to encode that.
 *
 * @internal
 */
export function createContinueAsNew(
  currentContract: ContractDefinition,
  currentWorkflowName: string | number | symbol,
) {
  return async function continueAsNew(
    arg1: unknown,
    arg2?: unknown,
    arg3?: unknown,
    arg4?: TypedContinueAsNewOptions,
  ): Promise<never> {
    // Cross-contract dispatch is only triggered when the call signature
    // unambiguously matches `(contract, workflowName, args, options?)`:
    //
    // 1. `arg1` is a non-null object that *looks like* a contract — it has a
    //    string `taskQueue` and a non-null `workflows` object.
    // 2. `arg2` is a string — the destination workflow name.
    // 3. `arg2` resolves to a workflow definition on `arg1.workflows` with a
    //    Standard Schema `input.~standard.validate` function.
    //
    // Without (2)+(3), a same-workflow input that happens to have `taskQueue`
    // and `workflows` keys (or `workflows = null`, where `typeof === "object"`)
    // would be silently misclassified. The full triple of structural checks
    // makes the false-positive surface vanishingly small.
    const isCrossContract = looksLikeCrossContractCall(arg1, arg2);

    let targetContract: ContractDefinition;
    let targetName: string;
    let rawArgs: unknown;
    let options: TypedContinueAsNewOptions | undefined;

    if (isCrossContract) {
      targetContract = arg1 as ContractDefinition;
      targetName = arg2 as string;
      rawArgs = arg3;
      options = arg4;
    } else {
      targetContract = currentContract;
      targetName = String(currentWorkflowName);
      rawArgs = arg1;
      options = arg2 as TypedContinueAsNewOptions | undefined;
    }

    const targetDef = targetContract.workflows[targetName];
    if (!targetDef) {
      throw new WorkflowInputValidationError(targetName, [
        {
          message: `continueAsNew target workflow "${targetName}" is not declared on the supplied contract.`,
        },
      ]);
    }

    const inputResult = await targetDef.input["~standard"].validate(rawArgs);
    if (inputResult.issues) {
      throw new WorkflowInputValidationError(targetName, inputResult.issues);
    }

    // workflowType/taskQueue come from the destination contract; user
    // options are spread last so power users can override (e.g. retry,
    // memo). The public TypedContinueAsNewOptions type Omits workflowType
    // and taskQueue so this isn't a footgun on the typed call path.
    const fn = makeContinueAsNewFunc({
      workflowType: targetName,
      taskQueue: targetContract.taskQueue,
      ...options,
    });

    await fn(inputResult.value);
    // Unreachable — Temporal's continueAsNew throws to terminate the run.
    /* c8 ignore next */
    return undefined as never;
  };
}

/**
 * Structural check: does `(arg1, arg2)` look like the
 * `(contract, workflowName, ...)` cross-contract overload of `continueAsNew`?
 *
 * Returns `true` only when:
 *   1. `arg1` is a non-null object with a string `taskQueue` and a non-null
 *      object `workflows` (handles `workflows: null`, where
 *      `typeof null === "object"`).
 *   2. `arg2` is a string.
 *
 * Both halves matter. A same-workflow input that happens to contain
 * `taskQueue` and `workflows` keys would otherwise be misclassified — but
 * none of the same-workflow signatures (`continueAsNew(args)`,
 * `continueAsNew(args, options)`) accept a string as `arg2`, so the
 * second check makes the false-positive surface vanishingly small.
 *
 * We deliberately do *not* check that `arg1.workflows[arg2]` is a valid
 * workflow definition. If it isn't, the dispatcher falls through to the
 * `targetContract.workflows[targetName]` lookup which throws a clear
 * "target workflow X is not declared" error — better than silently
 * misrouting a typo back to the current workflow.
 */
function looksLikeCrossContractCall(arg1: unknown, arg2: unknown): boolean {
  if (typeof arg1 !== "object" || arg1 === null) return false;
  if (typeof arg2 !== "string") return false;
  const candidate = arg1 as Record<string, unknown>;
  if (typeof candidate["taskQueue"] !== "string") return false;
  const workflows = candidate["workflows"];
  return typeof workflows === "object" && workflows !== null;
}

/**
 * Map a thrown error from `startChild` / `executeChild` / `handle.result()`
 * (the worker-side child-workflow API) into the discriminated union surfaced
 * by the typed worker. Mirrors the client's `classifyResultError`:
 *
 * - Cancellation (detected via `@temporalio/workflow`'s `isCancellation`,
 *   which sees through nested `ChildWorkflowFailure → CancelledFailure`
 *   chains) → {@link ChildWorkflowCancelledError}, with the original error
 *   carried as `cause`.
 * - Temporal's `ChildWorkflowFailure` (a wrapper whose actionable failure —
 *   `ApplicationFailure`, `TimeoutFailure`, `TerminatedFailure`, etc. — lives
 *   on its `cause` field) → {@link ChildWorkflowError}, with that *inner*
 *   cause forwarded so consumers can match `err.cause instanceof
 *   ApplicationFailure` without unwrapping twice. (If the wrapper's `cause`
 *   is `undefined`, the wrapper itself is forwarded so identity is
 *   preserved.)
 * - Anything else → {@link ChildWorkflowError} carrying the raw thrown value
 *   as `cause`.
 *
 * The `operation` discriminator drives the human-readable error message so
 * call sites don't have to format their own.
 *
 * Note: `ChildWorkflowNotFoundError` is *not* produced here — it's only
 * thrown from the input-validation path when the workflow definition is
 * missing on the contract, before any Temporal call happens.
 */
export function classifyChildWorkflowError(
  operation: "startChild" | "executeChild" | "result",
  error: unknown,
  childWorkflowName: string,
): ChildWorkflowError | ChildWorkflowCancelledError {
  // Cancellation takes priority: a cancelled child surfaces as a
  // `ChildWorkflowFailure` whose cause is a `CancelledFailure`, and we want
  // the cancellation discriminant rather than the generic wrapper.
  if (isCancellation(error)) {
    return new ChildWorkflowCancelledError(childWorkflowName, error);
  }

  // Temporal wraps the actionable failure (ApplicationFailure, TimeoutFailure,
  // TerminatedFailure, etc.) inside a ChildWorkflowFailure. Forward the
  // inner cause so consumers can branch on the failure category without
  // unwrapping twice. Fall back to the wrapper itself if `cause` is missing
  // so callers don't lose the error identity.
  if (error instanceof ChildWorkflowFailure) {
    const inner = error.cause ?? error;
    const innerMessage = inner instanceof Error ? inner.message : String(inner);
    return new ChildWorkflowError(
      `${describeChildWorkflowOperation(operation, childWorkflowName)}: ${innerMessage}`,
      inner,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ChildWorkflowError(
    `${describeChildWorkflowOperation(operation, childWorkflowName)}: ${message}`,
    error,
  );
}

function describeChildWorkflowOperation(
  operation: "startChild" | "executeChild" | "result",
  childWorkflowName: string,
): string {
  switch (operation) {
    case "startChild":
      return `Failed to start child workflow "${childWorkflowName}"`;
    case "executeChild":
      return `Failed to execute child workflow "${childWorkflowName}"`;
    case "result":
      return `Child workflow "${childWorkflowName}" execution failed`;
  }
}
