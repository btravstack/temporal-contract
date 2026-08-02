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
import type { WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { onTestFinished } from "vitest";

/**
 * Workflow-ID prefixes whose executions are deliberately left non-terminal, so
 * their histories cannot be replayed. Every entry needs a reason.
 *
 * This list may only ever shrink. A silently-skipped execution would report
 * replay coverage it does not have — exactly the rot this rig exists to
 * prevent — so an unlisted non-terminal execution fails the test instead.
 */
export const REPLAY_SKIP_ALLOWLIST: Record<string, string> = {};

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

export function isTerminalStatus(name: string): boolean {
  return TERMINAL_STATUSES.has(name);
}

export function skipReasonFor(
  workflowId: string,
  allowlist: Record<string, string>,
): string | undefined {
  for (const [prefix, reason] of Object.entries(allowlist)) {
    if (workflowId.startsWith(prefix)) return reason;
  }
  return undefined;
}

/** The three `ContractClient` methods that can start an execution. */
const START_METHODS = new Set(["startWorkflow", "executeWorkflow", "signalWithStart"]);

type RigOptions<TContract extends ContractDefinition> = {
  readonly contract: TContract;
  readonly bundle: WorkflowBundleWithSourceMap;
  readonly activities?: ActivitiesHandler<TContract>;
};

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

  const startedIds: string[] = [];

  const client = new Proxy(bound, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof property !== "string" || !START_METHODS.has(property)) return value;
      if (typeof value !== "function") return value;

      return (...args: readonly unknown[]) => {
        const bag = args[1];
        const workflowId =
          typeof bag === "object" && bag !== null && "workflowId" in bag
            ? (bag as { workflowId?: unknown }).workflowId
            : undefined;
        if (typeof workflowId === "string") startedIds.push(workflowId);
        return Reflect.apply(value as (...rest: readonly unknown[]) => unknown, target, args);
      };
    },
  }) as ContractClient<TContract>;

  onTestFinished(async () => {
    for (const workflowId of startedIds) {
      const handle = testEnv.client.workflow.getHandle(workflowId);
      const described = await handle.describe();

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

      const history = await handle.fetchHistory();
      await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId);
    }
  });

  return { worker, client };
}
