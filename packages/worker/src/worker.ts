// Entry point for worker creation utilities
import { ContractDefinition } from "@temporal-contract/contract";
import { TechnicalError } from "@temporal-contract/contract/errors";
import { Worker, WorkerOptions } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import { fromPromise, type AsyncResult } from "unthrown";
import type { ActivitiesHandler } from "./activity.js";

// Modeled creation failure — `createWorker` surfaces it on the Err channel
// instead of throwing.
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
   * Activities handler for this worker
   */
  activities: ActivitiesHandler<TContract>;
};

/**
 * Create a typed Temporal worker with contract-based configuration.
 *
 * This helper simplifies worker creation by:
 * - Using the contract's task queue automatically
 * - Providing type-safe configuration
 *
 * Returns `AsyncResult<Worker, TechnicalError>` — worker bundling and
 * connection failures are modeled on the `Err` channel instead of thrown,
 * matching the org-wide `Typed*.create()` factory shape (amqp-contract's
 * `TypedAmqpWorker.create`).
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
 * if (workerResult.isErr()) {
 *   console.error('worker setup failed', workerResult.error);
 *   process.exit(1);
 * }
 *
 * await workerResult.value.run();
 * ```
 */
export function createWorker<TContract extends ContractDefinition>(
  options: CreateWorkerOptions<TContract>,
): AsyncResult<Worker, TechnicalError> {
  const { contract, activities, ...workerOptions } = options;

  // Create the worker with contract's task queue. `Worker.create` rejects on
  // workflow-bundle compilation errors, bad connections, and invalid
  // options — all technical failures, modeled rather than thrown.
  return fromPromise(
    Worker.create({
      ...workerOptions,
      activities,
      taskQueue: contract.taskQueue,
    }),
    (cause) =>
      new TechnicalError(
        `Failed to create Temporal worker for task queue "${contract.taskQueue}"`,
        cause,
      ),
  );
}

/**
 * Create a typed Temporal worker, throwing on failure — the
 * pre-AsyncResult behavior.
 *
 * @deprecated Use {@link createWorker}, which returns
 * `AsyncResult<Worker, TechnicalError>`. This throwing alias exists to ease
 * migration and will be removed in a future major.
 */
export async function createWorkerOrThrow<TContract extends ContractDefinition>(
  options: CreateWorkerOptions<TContract>,
): Promise<Worker> {
  const result = await createWorker(options);
  return result.match({
    ok: (worker) => worker,
    err: (error) => {
      throw error.cause ?? error;
    },
    defect: (cause) => {
      throw cause;
    },
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
