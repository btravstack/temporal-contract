import type { ContractClient } from "@temporal-contract/client";
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
import { onTestFinished } from "vitest";

/**
 * Workflow-ID prefixes whose executions are deliberately left non-terminal, so
 * their histories cannot be replayed. Every entry needs a reason.
 *
 * This list may only ever shrink. A silently-skipped execution would report
 * replay coverage it does not have — exactly the rot this rig exists to
 * prevent — so an unlisted non-terminal execution fails the test instead.
 */
export const REPLAY_SKIP_ALLOWLIST: Readonly<Record<string, string>> = {};

/** Statuses whose history is complete and therefore replayable. */
const TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TERMINATED",
  "TIMED_OUT",
  // The run ended; the next run is a separate execution with its own history.
  "CONTINUED_AS_NEW",
]);

/**
 * Whether a workflow-execution status names a finished run, and is therefore
 * safe to fetch and replay. An unscoped `handle.describe()` (no `runId`)
 * always resolves to the *latest* run in a chain, so in practice it can
 * never itself report `CONTINUED_AS_NEW` — that status only ever shows up if
 * a caller describes a specific older run directly. It's kept in the set
 * anyway because it genuinely is a finished, replayable state for whichever
 * run it's read from.
 */
export function isTerminalStatus(name: string): boolean {
  return TERMINAL_STATUSES.has(name);
}

/**
 * Look up the {@link REPLAY_SKIP_ALLOWLIST} reason for a non-terminal
 * execution, matching by workflow-ID *prefix* so one entry covers every
 * workflow ID `nextTaskQueueId`-style counters generate from a shared base
 * (e.g. `"probe-edge-cases"` matches `"probe-edge-cases-1"`,
 * `"probe-edge-cases-2"`, ...). Returns `undefined` for anything unlisted,
 * so the caller can fail loudly instead of silently under-reporting replay
 * coverage.
 */
export function skipReasonFor(
  workflowId: string,
  allowlist: Readonly<Record<string, string>>,
): string | undefined {
  for (const [prefix, reason] of Object.entries(allowlist)) {
    if (workflowId.startsWith(prefix)) return reason;
  }
  return undefined;
}

/** The three `ContractClient` methods that can start an execution. */
const START_METHODS = new Set(["startWorkflow", "executeWorkflow", "signalWithStart"]);

/**
 * Pull the `workflowId` out of a start method's options bag (its second
 * argument, per every `START_METHODS` signature) so the rig knows which
 * execution to replay later.
 *
 * This is the rig's single load-bearing assumption about another package's
 * call shape — held with no runtime enforcement anywhere else. Throwing here
 * when the assumption doesn't hold is deliberate: the alternative is
 * `startedIds` silently staying empty, `onTestFinished` iterating nothing,
 * and the test passing green while proving zero replay coverage — exactly
 * the failure mode this whole rig exists to prevent. Pure and exported so
 * the guard is unit-testable without a server.
 */
export function extractStartedWorkflowId(methodName: string, args: readonly unknown[]): string {
  const bag = args[1];
  const workflowId =
    typeof bag === "object" && bag !== null && "workflowId" in bag
      ? (bag as { workflowId?: unknown }).workflowId
      : undefined;
  if (typeof workflowId !== "string") {
    // oxlint-disable-next-line unthrown/no-throw -- test-harness assertion: guards the rig's one load-bearing assumption about ContractClient's call shape; see this function's JSDoc
    throw new Error(
      `testRig expected "${methodName}"'s second argument to carry a string "workflowId" ` +
        `(every Temporal WorkflowOptions requires one) but received: ${JSON.stringify(bag)}. ` +
        `Without it, this execution's history can never be harvested for replay.`,
    );
  }
  return workflowId;
}

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
 */
export async function testRig<TContract extends ContractDefinition>(
  testEnv: TestWorkflowEnvironment,
  options: RigOptions<TContract>,
): Promise<{ worker: TypedWorker; client: ContractClient<TContract> }> {
  const { contract, bundle, activities } = options;

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

  // A `Set`: a test that calls e.g. `signalWithStart` more than once against
  // the same workflow ID must not queue the same replay twice.
  const startedIds = new Set<string>();

  const client = new Proxy(bound, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== "string" || !START_METHODS.has(property)) return value;
      if (typeof value !== "function") return value;
      const methodName = property;

      return (...args: readonly unknown[]) => {
        startedIds.add(extractStartedWorkflowId(methodName, args));
        return Reflect.apply(value as (...rest: readonly unknown[]) => unknown, target, args);
      };
    },
  }) as ContractClient<TContract>;

  onTestFinished(async () => {
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
        const reason = skipReasonFor(workflowId, REPLAY_SKIP_ALLOWLIST);
        if (reason === undefined) {
          // oxlint-disable-next-line unthrown/no-throw -- test-harness assertion: onTestFinished has no Result seam, and Vitest surfaces test failures via throw
          throw new Error(
            `Workflow "${workflowId}" ended ${described.status.name}, so its history cannot be ` +
              `replayed and this test proves nothing about replay determinism for it. Either make ` +
              `the execution terminal, or add a REPLAY_SKIP_ALLOWLIST entry in ` +
              `packages/testing/src/test-rig.ts with a reason.`,
          );
        }
        continue;
      }

      await replayChain(testEnv.client, bundle, workflowId);
    }
  });

  return { worker, client };
}
