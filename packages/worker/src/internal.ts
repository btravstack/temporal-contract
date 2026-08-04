import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  type ActivityDefinition,
  type ContractDefinition,
  summarizeIssues,
} from "@temporal-contract/contract";
import { ChildWorkflowFailure } from "@temporalio/common";
/**
 * Internal helpers shared across the worker package's entry points.
 *
 * Not part of the public API — this module is not listed in the package's
 * `exports` map, so consumers can't import from `@temporal-contract/worker/internal`.
 * In-package tests import it directly via relative path.
 */
import { isCancellation, makeContinueAsNewFunc, proxyActivities } from "@temporalio/workflow";
import type { ActivityOptions, ContinueAsNewOptions } from "@temporalio/workflow";

import {
  type BoundViolation,
  formatUnboundedActivitiesMessage,
  missingBounds,
} from "./activity-bounds.js";
import {
  ChildWorkflowCancelledError,
  ChildWorkflowError,
  ContractMisuseError,
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
} from "@temporal-contract/contract/internal";

/**
 * Extract the single payload from a Temporal handler's `...args` array.
 *
 * Temporal invokes handlers with whatever was passed via `args: [...]` at the
 * call site. The typed-contract layer always sends `args: [input]` — the
 * caller's original (validated but untransformed) value, which the receiving
 * handler parses — so the common case is a one-element array containing the
 * wrapped input.
 *
 * Zero arguments map to `undefined`, not `[]`: a payload-less send (e.g. a
 * signal declared without an `input` schema, whose materialized
 * `UndefinedInputSchema` only accepts `undefined`/`null`) must parse as "no
 * payload", and an empty array would be rejected by that schema.
 *
 * If a non-typed-contract caller passes multiple positional arguments
 * (`args: [a, b, c]`), we surface the whole array as the input — the schema
 * will then reject it unless the contract specifically modeled a tuple.
 */
export function extractHandlerInput(args: unknown[]): unknown {
  if (args.length === 0) return undefined;
  return args.length === 1 ? args[0] : args;
}

type ActivityFn = (...args: unknown[]) => Promise<unknown>;

/**
 * Build the raw `Record<name, fn>` proxy of activities for a workflow,
 * applying contract-level `activityOptions` and per-activity
 * `ActivityOptions` overrides where present.
 *
 * **Fast path (no contract defaults, no overrides):** a single
 * `proxyActivities(defaultOptions)` call is made and returned directly. The
 * proxy synthesizes a function for any property access by name, so
 * downstream code that looks up `proxy[activityName]` works identically to
 * before.
 *
 * **Merged path:** one extra `proxyActivities(merged)` call is made *only*
 * for each activity whose effective options differ from the workflow-wide
 * default — i.e. it declares `activityOptions` on the contract and/or has an
 * `activityOptionsByName` override. Activities without either keep using the
 * single default proxy. The result is a `Proxy` that returns the bound
 * function for named keys and falls back to the default proxy for everything
 * else — so the per-execution overhead scales with the number of customized
 * activities, not the total number of activities.
 *
 * Merge precedence (least → most specific), each layer shallow-merging over
 * the previous — a layer that specifies a property replaces it entirely,
 * including the whole nested `retry` block, matching Temporal's
 * "one ActivityOptions per `proxyActivities` call" semantics:
 *
 *   1. `declareWorkflow`'s `activityOptions` (workflow-wide default)
 *   2. the contract's `defineActivity({ activityOptions })` (activity-specific,
 *      shared by every worker)
 *   3. `activityOptionsByName` (explicit per-workflow, per-activity override)
 */
export function buildRawActivitiesProxy(
  workflowActivities: Record<string, ActivityDefinition> | undefined,
  contractActivities: Record<string, ActivityDefinition> | undefined,
  defaultOptions: ActivityOptions | undefined,
  overrides: Partial<Record<string, ActivityOptions>> | undefined,
): Record<string, ActivityFn> {
  const allDefinitions: Record<string, ActivityDefinition> = {
    ...contractActivities,
    ...workflowActivities,
  };

  // Every reachable activity must carry BOTH bounds in its MERGED options: a
  // per-attempt bound and a total bound. See `activity-bounds.ts` for why the
  // two are independent.
  //
  // Checked on the MERGE, not per source. The layers shallow-merge, so a
  // contract-level `retry: { initialInterval: "2s" }` replaces a workflow-wide
  // `retry: { maximumAttempts: 3 }` wholesale and silently drops the bound —
  // both layers look bounded in isolation.
  //
  // Checked UNCONDITIONALLY. The previous version ran only when
  // `defaultOptions` was absent, so any truthy `activityOptions` on
  // `declareWorkflow` skipped it for every activity.
  //
  // This must run BEFORE the `proxyActivities` calls below. Temporal validates
  // options at proxy CONSTRUCTION (`@temporalio/workflow` `lib/workflow.js:496-502`)
  // and throws a plain `TypeError`, which inside the sandbox is retried as a
  // Workflow Task failure forever (D3): the workflow hangs rather than failing.
  const violations: BoundViolation[] = [];
  for (const [name, definition] of Object.entries(allDefinitions)) {
    // Must mirror the merge at the bottom of this function EXACTLY, including
    // its shallowness — a deep merge here would report bounds the running
    // workflow will not actually have.
    const merged: ActivityOptions = {
      ...defaultOptions,
      ...(definition.activityOptions as ActivityOptions | undefined),
      ...overrides?.[name],
    };
    const missing = missingBounds(merged);
    if (missing.length > 0) {
      violations.push({ name, missing });
    }
  }
  if (violations.length > 0) {
    // ContractMisuseError (a non-retryable ApplicationFailure), not a plain
    // Error: this runs inside the workflow sandbox, where a plain Error would
    // be retried as a Workflow Task failure forever (D3).
    // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: declaration-time fail-fast as a non-retryable ApplicationFailure (CLAUDE.md rule 2 exception)
    throw new ContractMisuseError(formatUnboundedActivitiesMessage(violations));
  }

  // Build the workflow-wide proxy only if some activity actually relies on it.
  // When every activity carries its own options, `defaultOptions` is never
  // the effective options for anything, and the loop above never validated
  // it — constructing a proxy from an unbounded default would throw
  // Temporal's plain `TypeError` (→ workflow-task stall) for options no
  // activity would ever have used. The same reasoning covers the
  // no-activities case.
  const needsDefaultProxy = Object.entries(allDefinitions).some(([name, definition]) => {
    const contractDefaults = definition.activityOptions;
    const override = overrides?.[name];
    const hasContractDefaults = contractDefaults && Object.keys(contractDefaults).length > 0;
    const hasOverride = override && Object.keys(override).length > 0;
    return !hasContractDefaults && !hasOverride;
  });
  const defaultProxy =
    defaultOptions && needsDefaultProxy
      ? proxyActivities<Record<string, ActivityFn>>(defaultOptions)
      : undefined;

  // Validate every override key corresponds to a declared activity.
  // Without this, a typo at runtime (or a stale options bag from a renamed
  // activity) silently builds a proxy for a non-existent activity.
  const overrideEntries = overrides
    ? Object.entries(overrides).filter(
        (entry): entry is [string, ActivityOptions] => entry[1] !== undefined,
      )
    : [];
  for (const [name] of overrideEntries) {
    if (!(name in allDefinitions)) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ContractMisuseError model: declaration-time fail-fast as a non-retryable ApplicationFailure (CLAUDE.md rule 2 exception)
      throw new ContractMisuseError(
        `activityOptionsByName entry "${name}" does not match any declared activity. Available: ${Object.keys(allDefinitions).join(", ") || "none"}.`,
      );
    }
  }
  const overrideByName = Object.fromEntries(overrideEntries);

  // Merged path: build one proxy per customized activity; combine with the
  // default proxy via a get-trap so unmatched keys still get the default
  // options.
  const customizedFns: Record<string, ActivityFn> = {};
  for (const [name, definition] of Object.entries(allDefinitions)) {
    const contractDefaults = definition.activityOptions;
    const override = overrideByName[name];
    // An empty options bag can't change the effective options — treat it as
    // absent so the "one extra proxy only when options differ" optimization
    // holds for `activityOptions: {}` / `activityOptionsByName: { x: {} }`.
    const hasContractDefaults = contractDefaults && Object.keys(contractDefaults).length > 0;
    const hasOverride = override && Object.keys(override).length > 0;
    if (!hasContractDefaults && !hasOverride) {
      continue;
    }
    // The contract types durations as plain `string | number` (it carries no
    // `@temporalio/*` dependency, so it can't reference Temporal's
    // template-literal `Duration` type); the values are `ms`-compatible at
    // runtime, so the widening cast is safe.
    const mergedOptions: ActivityOptions = {
      ...defaultOptions,
      ...(contractDefaults as ActivityOptions | undefined),
      ...override,
    };
    const mergedProxy = proxyActivities<Record<string, ActivityFn>>(mergedOptions);
    const fn = mergedProxy[name];
    if (fn !== undefined) {
      customizedFns[name] = fn;
    }
  }

  // Fast path: nothing customized → use the single default proxy directly.
  // (`createValidatedActivities` accesses by name, so the Proxy's get-trap
  // suffices; we don't need an enumerable map.) The `?? {}` covers BOTH
  // degenerate no-activities cases: no-activities + no-defaults (`defaultProxy`
  // is never built because `defaultOptions` is falsy) and no-activities WITH
  // defaults (`needsDefaultProxy`'s `.some` over an empty `allDefinitions` is
  // `false`, so `defaultProxy` is never built even though `defaultOptions` is set).
  if (Object.keys(customizedFns).length === 0) {
    return defaultProxy ?? {};
  }

  return new Proxy(customizedFns, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      return target[prop] ?? defaultProxy?.[prop];
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
 * invalid run. As a SENDING side of the input boundary, the parsed value is
 * discarded: the original args go over the wire, and the new run's
 * `declareWorkflow` parses them on receive (transforms apply exactly once).
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
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new WorkflowInputValidationError(targetName, [
        {
          message: `continueAsNew target workflow "${targetName}" is not declared on the supplied contract.`,
        },
      ]);
    }

    const inputResult = await targetDef.input["~standard"].validate(rawArgs);
    if (inputResult.issues) {
      // oxlint-disable-next-line unthrown/no-throw -- sanctioned ValidationError/ApplicationFailure model: terminal failure Temporal must see thrown (CLAUDE.md rule 2 exception)
      throw new WorkflowInputValidationError(targetName, inputResult.issues);
    }

    // workflowType/taskQueue come from the destination contract and are set
    // LAST, after the user-options spread, so callers cannot override the
    // validated target — the args were just validated against `targetName`'s
    // input schema, and routing them to a different workflow type or task
    // queue would bypass that validation. The public TypedContinueAsNewOptions
    // type already Omits `workflowType`/`taskQueue`; this ordering closes the
    // `as never` / plain-JavaScript escape hatch too.
    const fn = makeContinueAsNewFunc({
      ...options,
      workflowType: targetName,
      taskQueue: targetContract.taskQueue,
    });

    // Transmit the ORIGINAL args — validated above, parsed by the new run's
    // `declareWorkflow` on receive (D1).
    await fn(rawArgs);
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
 * / `handle.signal(...)` (the worker-side child-workflow API) into the
 * discriminated union surfaced by the typed worker. Mirrors the client's
 * `classifyResultError`:
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
  operation: "startChild" | "executeChild" | "result" | "signal",
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
      childWorkflowName,
      `${describeChildWorkflowOperation(operation, childWorkflowName)}: ${innerMessage}`,
      inner,
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ChildWorkflowError(
    childWorkflowName,
    `${describeChildWorkflowOperation(operation, childWorkflowName)}: ${message}`,
    error,
  );
}

function describeChildWorkflowOperation(
  operation: "startChild" | "executeChild" | "result" | "signal",
  childWorkflowName: string,
): string {
  switch (operation) {
    case "startChild":
      return `Failed to start child workflow "${childWorkflowName}"`;
    case "executeChild":
      return `Failed to execute child workflow "${childWorkflowName}"`;
    case "result":
      return `Child workflow "${childWorkflowName}" execution failed`;
    case "signal":
      return `Failed to signal child workflow "${childWorkflowName}"`;
  }
}
