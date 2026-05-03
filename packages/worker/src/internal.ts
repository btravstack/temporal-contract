/**
 * Internal helpers shared across the worker package's entry points.
 *
 * Not part of the public API — this module is not listed in the package's
 * `exports` map, so consumers can't import from `@temporal-contract/worker/internal`.
 * In-package tests import it directly via relative path.
 */
import { ContinueAsNewOptions, makeContinueAsNewFunc, proxyActivities } from "@temporalio/workflow";
import type { ActivityOptions } from "@temporalio/workflow";
import type { ActivityDefinition, ContractDefinition } from "@temporal-contract/contract";
import { WorkflowInputValidationError } from "./errors.js";

// Re-export the formatters so workflow.ts and existing tests can keep
// importing from `./internal.js`. Their canonical home is `./format.js`,
// which both `errors.ts` and `internal.ts` import from to avoid a
// circular dependency once `internal.ts` started importing error classes.
export { formatIssue, summarizeIssues, formatChildWorkflowValidationMessage } from "./format.js";

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
    // Heuristic: a contract object has both `taskQueue: string` and
    // `workflows: Record<string, ...>`. Plain workflow input objects don't.
    const isCrossContract =
      typeof arg1 === "object" &&
      arg1 !== null &&
      "taskQueue" in arg1 &&
      typeof (arg1 as ContractDefinition).taskQueue === "string" &&
      "workflows" in arg1 &&
      typeof (arg1 as ContractDefinition).workflows === "object";

    let targetContract: ContractDefinition;
    let targetName: string;
    let rawArgs: unknown;
    let options: TypedContinueAsNewOptions | undefined;

    if (isCrossContract) {
      targetContract = arg1 as ContractDefinition;
      targetName = String(arg2);
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
