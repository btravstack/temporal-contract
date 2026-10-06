import type { ContractClient, WorkflowValidationError } from "@temporal-contract/client";
import { TypedClient } from "@temporal-contract/client";
import type { ContractDefinition } from "@temporal-contract/contract";
// `ActivitiesHandler` lives on the /activity subpath — worker.ts imports it
// but does not re-export it. `TypedWorker` is both a type and a value, so one
// non-type import covers both uses.
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";
import { TypedWorker } from "@temporal-contract/worker/worker";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { History, WorkflowBundleWithSourceMap } from "@temporalio/worker";
import type { AsyncResult } from "unthrown";
import { onTestFinished } from "vitest";

import {
  extractStartedWorkflowId,
  isTerminalStatus,
  skipReasonFor,
  START_METHODS,
} from "./internal.js";

/**
 * Duck-types `@temporalio/common`'s `WorkflowNotFoundError` by `error.name`
 * rather than `instanceof`, so this module doesn't need `@temporalio/common`
 * as a direct dependency — `@temporalio/client`'s decorator-based error
 * classes (`SymbolBasedInstanceOfError`) set `name` on the prototype
 * unconditionally, so the check is as reliable as an `instanceof` would be.
 */
function isWorkflowNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === "WorkflowNotFoundError";
}

type RigOptions<TContract extends ContractDefinition> = {
  readonly contract: TContract;
  readonly bundle: WorkflowBundleWithSourceMap;
  readonly activities?: ActivitiesHandler<TContract>;
  /**
   * Workflow-ID prefixes (longest prefix wins) whose executions
   * are deliberately left non-terminal, so their histories cannot be
   * replayed. Every entry needs a reason. Defaults to `{}` — a published rig
   * cannot know a consuming repo's fixture IDs, so nothing is skipped unless
   * the caller opts a workflow ID in explicitly.
   *
   * This list may only ever shrink per caller. A silently-skipped execution
   * would report replay coverage it does not have — exactly the rot this rig
   * exists to prevent — so an unlisted non-terminal execution fails the test
   * instead.
   */
  readonly replaySkipAllowlist?: Readonly<Record<string, string>>;
};

/**
 * Replay every run in a continue-as-new/retry/cron chain by walking
 * *backward* from the latest run, replaying newest to oldest as each prior
 * run's id is discovered.
 *
 * `getHandle(workflowId)` with no `runId` binds to the newest run, so its
 * history alone omits every earlier run — including the ones that actually
 * contain the continue-as-new command, the determinism surface most worth
 * replaying. Each run's `WorkflowExecutionStarted` event records the prior
 * run's id in `continuedExecutionRunId` (populated for continue-as-new,
 * retry, and cron alike), so walking that pointer back to its origin and
 * replaying each run visited is the only way to cover the whole chain.
 * Earlier runs need no `describe()` / terminal check of their own: a run
 * reachable this way already closed — that's *why* the next run exists.
 */
async function replayChain(
  client: TestWorkflowEnvironment["client"],
  bundle: WorkflowBundleWithSourceMap,
  workflowId: string,
): Promise<void> {
  let runId: string | undefined = undefined;
  for (;;) {
    const history: History = await client.workflow.getHandle(workflowId, runId).fetchHistory();
    await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId);

    const previousRunId =
      history.events?.[0]?.workflowExecutionStartedEventAttributes?.continuedExecutionRunId;
    if (previousRunId === null || previousRunId === undefined || previousRunId === "") return;
    runId = previousRunId;
  }
}

/**
 * Build the worker + client pair every in-process test needs, and register an
 * `onTestFinished` hook that replays the history of every execution the client
 * started.
 *
 * The rig deliberately does NOT scope the task queue — callers keep calling
 * `withTaskQueue` themselves. A same-workflow continue-as-new must land on the
 * contract's static queue, because the contract is closed over inside the
 * bundled workflow module and a test-side copy can never reach it.
 *
 * @public consumed from sibling packages' suites via the
 * `@temporal-contract/testing/test-rig` subpath; the tsconfig `paths`
 * indirection hides that usage from knip.
 */
export async function testRig<TContract extends ContractDefinition>(
  testEnv: TestWorkflowEnvironment,
  options: RigOptions<TContract>,
): Promise<{ worker: TypedWorker; client: ContractClient<TContract> }> {
  const { contract, bundle, activities, replaySkipAllowlist = {} } = options;

  // `TypedWorker.create`/`TypedClient.create` have an empty Err channel — see
  // "Setup calls have an empty Err channel" in
  // docs/explanation/the-result-model.md.
  const worker = await TypedWorker.create({
    contract,
    connection: testEnv.nativeConnection,
    workflowBundle: bundle,
    // Spread conditionally: `TypedWorker.create` distinguishes an absent
    // `activities` key from `activities: undefined` (a workflow-only worker
    // must not register an activity poller).
    ...(activities !== undefined ? { activities } : {}),
  }).get();

  const typedClient = await TypedClient.create({ client: testEnv.client }).get();
  const bound = typedClient.for(contract);

  // Guards the Proxy's own load-bearing assumption below: every name in
  // `START_METHODS` must resolve to an actual method on `bound`. A rename
  // (or a new start method `START_METHODS` doesn't know about yet) would
  // otherwise make the Proxy silently stop intercepting that method —
  // `startedIds` stays empty, `onTestFinished` iterates nothing, and the
  // whole tier goes green proving zero replay coverage. Thrown eagerly, at
  // rig setup, rather than left to surface as a quiet coverage gap later.
  for (const methodName of START_METHODS) {
    if (typeof (bound as unknown as Record<string, unknown>)[methodName] !== "function") {
      // oxlint-disable-next-line unthrown/no-throw -- test-harness assertion: guards the rig's load-bearing assumption that every START_METHODS name is a real ContractClient method
      throw new Error(
        `testRig's START_METHODS names "${methodName}", but ContractClient has no such method. ` +
          `Either the method was renamed or removed (update START_METHODS in ` +
          `packages/testing/src/internal.ts to match), or this is a typo.`,
      );
    }
  }

  // Every start call's workflow ID: the caller's own, or — for a workflow
  // whose contract derives it — the pending `workflowIdFor` lookup.
  const started: (string | AsyncResult<string, WorkflowValidationError>)[] = [];

  const client = new Proxy(bound, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== "string" || !START_METHODS.has(property)) return value;
      if (typeof value !== "function") return value;
      const methodName = property;

      return (...args: readonly unknown[]) => {
        const [workflowName, bag] = args as [string, { args?: unknown } | undefined];
        const derivesId = typeof contract.workflows[workflowName]?.workflowId === "function";
        started.push(
          extractStartedWorkflowId(methodName, args, derivesId) ??
            (
              target.workflowIdFor as (
                name: string,
                input: unknown,
              ) => AsyncResult<string, WorkflowValidationError>
            )(workflowName, bag?.args),
        );
        return Reflect.apply(value as (...rest: readonly unknown[]) => unknown, target, args);
      };
    },
  }) as ContractClient<TContract>;

  onTestFinished(async () => {
    // A `Set`: a test that calls e.g. `signalWithStart` more than once against
    // the same workflow ID must not queue the same replay twice.
    const startedIds = new Set<string>();
    for (const entry of started) {
      if (typeof entry === "string") {
        startedIds.add(entry);
        continue;
      }
      // `undefined` on `Err`: the input failed validation, so the start it
      // belongs to failed the same validation before dispatch — nothing to
      // replay. A defect (a throwing derivation) rethrows.
      const workflowId = await entry.getOrUndefined();
      if (workflowId !== undefined) startedIds.add(workflowId);
    }

    for (const workflowId of startedIds) {
      const handle = testEnv.client.workflow.getHandle(workflowId);
      let described;
      try {
        described = await handle.describe();
      } catch (error) {
        // A start call recorded this id, but the server never dispatched
        // it — e.g. it failed contract validation before the RPC went out.
        // Nothing was ever created, so there's nothing to replay.
        if (isWorkflowNotFoundError(error)) continue;
        // oxlint-disable-next-line unthrown/no-throw -- sanctioned re-raise: an unrecognized describe() failure must keep riding its original error, not be swallowed by this WorkflowNotFoundError-specific catch
        throw error;
      }

      if (!isTerminalStatus(described.status.name)) {
        const reason = skipReasonFor(workflowId, replaySkipAllowlist);
        if (reason === undefined) {
          // oxlint-disable-next-line unthrown/no-throw -- test-harness assertion: onTestFinished has no Result seam, and Vitest surfaces test failures via throw
          throw new Error(
            `Workflow "${workflowId}" ended ${described.status.name}, so its history cannot be ` +
              `replayed and this test proves nothing about replay determinism for it. Either make ` +
              `the execution terminal, or add an entry with a reason to the "replaySkipAllowlist" ` +
              `passed to this testRig(...) call.`,
          );
        }
        continue;
      }

      await replayChain(testEnv.client, bundle, workflowId);
    }
  });

  return { worker, client };
}
