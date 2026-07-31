import type { ContractDefinition } from "@temporal-contract/contract";
import { bundleWorkflowCode, type WorkflowBundleWithSourceMap } from "@temporalio/worker";

/**
 * Workflow bundles are the expensive part of standing up a test worker —
 * webpack runs over the whole workflow module graph. This module-level
 * `Map` memoizes each bundle per `workflowsPath` so a spec file that stands
 * up several test workers against the same workflow module pays the
 * bundling cost once instead of once per test.
 *
 * Under Vitest's default isolation (`pool: "forks"`, `isolate: true`), each
 * test *file* gets a fresh module registry, so this cache's lifetime is
 * per test file, not per Vitest worker process — it does not survive
 * across spec files. That's sufficient here: the goal is collapsing
 * per-test bundling within a file down to one bundle, not sharing a bundle
 * across files.
 *
 * Keyed by path, and the *promise* is cached (not the resolved value) so
 * concurrent callers share one in-flight bundle rather than racing.
 */
const bundles = new Map<string, Promise<WorkflowBundleWithSourceMap>>();

/**
 * Bundle `workflowsPath` once per test file and reuse it thereafter.
 * Pass the result straight to `TypedWorker.create({ workflowBundle })`.
 */
export function bundleFor(workflowsPath: string): Promise<WorkflowBundleWithSourceMap> {
  const cached = bundles.get(workflowsPath);
  if (cached) return cached;

  const bundle = bundleWorkflowCode({ workflowsPath });
  bundles.set(workflowsPath, bundle);
  return bundle;
}

/**
 * `TypedWorker.create` hard-codes `taskQueue: contract.taskQueue` and its
 * options type omits `taskQueue` entirely, so a per-test queue cannot be
 * passed through the worker options. Scope the *contract* instead.
 *
 * Returns a shallow copy — the workflow/activity definitions are shared by
 * reference, which matters: `defineContract` treats the same definition
 * object reused across scopes as one activity, not a collision.
 */
export function withTaskQueue<TContract extends ContractDefinition>(
  contract: TContract,
  id: string,
): TContract {
  return { ...contract, taskQueue: id };
}

let counter = 0;

/**
 * Monotonic task-queue id. Deliberately a counter rather than
 * `Math.random()` / `Date.now()` so a failing run is reproducible.
 */
export function nextTaskQueueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}
