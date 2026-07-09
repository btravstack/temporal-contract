// Entry point for worker creation utilities
import { ContractDefinition } from "@temporal-contract/contract";
import { Worker, WorkerOptions } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import type { ActivitiesHandler } from "./activity.js";

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
   * Activities handler for this worker
   */
  activities: ActivitiesHandler<TContract>;
};

/**
 * Create a typed Temporal worker with contract-based configuration
 *
 * This helper simplifies worker creation by:
 * - Using the contract's task queue automatically
 * - Providing type-safe configuration
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
 * const worker = await createWorker({
 *   contract: myContract,
 *   connection,
 *   workflowsPath: workflowsPathFromURL(import.meta.url, './workflows.js'),
 *   activities,
 * });
 *
 * await worker.run();
 * ```
 */
export async function createWorker<TContract extends ContractDefinition>(
  options: CreateWorkerOptions<TContract>,
): Promise<Worker> {
  const { contract, activities, ...workerOptions } = options;

  // Create the worker with contract's task queue
  return await Worker.create({
    ...workerOptions,
    activities,
    taskQueue: contract.taskQueue,
  });
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
