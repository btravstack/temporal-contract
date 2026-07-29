import { fileURLToPath } from "node:url";

// Entry point for worker creation utilities
import { type ContractDefinition } from "@temporal-contract/contract";
import { TechnicalError } from "@temporal-contract/contract/errors";
import { Worker, type WorkerOptions } from "@temporalio/worker";
import { fromPromise, type AsyncResult } from "unthrown";

import type { ActivitiesHandler } from "./activity.js";

// Technical creation failure — worker bundling / connection errors are
// unmodeled infrastructure defects, surfaced on the `Defect` channel with a
// {@link TechnicalError} instance as their cause (never in the `Err` channel).
export { TechnicalError } from "@temporal-contract/contract/errors";

/**
 * Options for creating a Temporal worker
 */
export type CreateWorkerOptions<TContract extends ContractDefinition> = Omit<
  WorkerOptions,
  "activities" | "taskQueue"
> & {
  /**
   * The contract definition for this worker
   */
  contract: TContract;

  /**
   * Activities handler for this worker, built with
   * `declareActivitiesHandler`.
   *
   * Optional — omit it for a **workflow-only worker**. When absent, no
   * `activities` are registered with the underlying Temporal Worker, so it
   * only polls for Workflow Tasks. This supports the split-deployment
   * pattern where workflow code and activity code scale independently: one
   * worker process runs the (deterministic, CPU-light) workflows while a
   * separate worker process on the same task queue registers the activities.
   */
  activities?: ActivitiesHandler<TContract>;
};

/**
 * Create a typed Temporal worker with contract-based configuration.
 *
 * This helper simplifies worker creation by:
 * - Using the contract's task queue automatically
 * - Providing type-safe configuration
 *
 * Returns `AsyncResult<Worker, never>` — worker bundling and connection
 * failures are *technical* infrastructure faults, not anticipated domain
 * errors, so they surface on the `Defect` channel (a {@link TechnicalError}
 * instance as the defect's cause) rather than the modeled `Err` channel.
 * Inspect them via `match`'s `defect` handler or `recoverDefect` / `tapDefect`.
 *
 * @example
 * ```ts
 * import { NativeConnection } from '@temporalio/worker';
 * import { createWorker, workflowsPathFromURL } from '@temporal-contract/worker/worker';
 * import { activities } from './activities.js';
 * import myContract from './contract.js';
 *
 * const connection = await NativeConnection.connect({
 *   address: 'localhost:7233',
 * });
 *
 * const workerResult = await createWorker({
 *   contract: myContract,
 *   connection,
 *   workflowsPath: workflowsPathFromURL(import.meta.url, './workflows.js'),
 *   activities,
 * });
 * if (workerResult.isDefect()) {
 *   console.error('worker setup failed', workerResult.cause);
 *   process.exit(1);
 * }
 *
 * await workerResult.value.run();
 * ```
 */
export function createWorker<TContract extends ContractDefinition>(
  options: CreateWorkerOptions<TContract>,
): AsyncResult<Worker, never> {
  const { contract, activities, ...workerOptions } = options;

  // Create the worker with contract's task queue. `Worker.create` rejects on
  // workflow-bundle compilation errors, bad connections, and invalid
  // options — all *technical* faults, routed to the defect channel with a
  // `TechnicalError` cause (never a modeled `Err`).
  //
  // `activities` is spread conditionally: a workflow-only worker must not
  // pass the key at all (exactOptionalPropertyTypes discipline — and Temporal
  // treats an absent map as "don't poll for Activity Tasks").
  return fromPromise(
    Worker.create({
      ...workerOptions,
      ...(activities !== undefined ? { activities } : {}),
      taskQueue: contract.taskQueue,
    }),
    (cause, defect) =>
      defect(
        new TechnicalError(
          `Failed to create Temporal worker for task queue "${contract.taskQueue}"`,
          cause,
        ),
      ),
  );
}

/**
 * Create a typed Temporal worker, throwing on failure — the
 * pre-AsyncResult behavior.
 *
 * @deprecated Use {@link createWorker}, which returns
 * `AsyncResult<Worker, never>` (technical failures ride the defect channel).
 * This throwing alias exists to ease migration and will be removed in a
 * future major.
 */
export async function createWorkerOrThrow<TContract extends ContractDefinition>(
  options: CreateWorkerOptions<TContract>,
): Promise<Worker> {
  const result = await createWorker(options);
  // A technical failure now rides the defect channel with a `TechnicalError`
  // cause; unwrap it so this throwing alias keeps rethrowing the *original*
  // cause (its pre-defect behavior), not the wrapper.
  if (result.isDefect() && result.cause instanceof TechnicalError) {
    throw result.cause.cause ?? result.cause;
  }
  return result.get();
}

/**
 * Helper to resolve a workflow file path relative to the current module's URL.
 *
 * Useful when using ES modules (`import.meta.url`) to locate workflow files.
 * The `relativePath` should include the file extension explicitly (e.g. `./workflows.js`)
 * to ensure the resolved path is unambiguous in both source and built contexts.
 *
 * @param baseURL - The base URL to resolve from, typically `import.meta.url`
 * @param relativePath - Relative path to the workflows file, **including extension**
 *
 * @example
 * ```ts
 * import { workflowsPathFromURL } from '@temporal-contract/worker/worker';
 *
 * const worker = await createWorker({
 *   contract: myContract,
 *   connection,
 *   // Include the extension explicitly to work in both source (.ts) and build (.js) contexts
 *   workflowsPath: workflowsPathFromURL(import.meta.url, './workflows.js'),
 *   activities,
 * });
 * ```
 */
export function workflowsPathFromURL(baseURL: string, relativePath: string): string {
  return fileURLToPath(new URL(relativePath, baseURL));
}
