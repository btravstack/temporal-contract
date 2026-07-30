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
 * Options for {@link TypedWorker.create} — the single options-object shape
 * shared by the org's `Typed*.create()` factories.
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
 * Contract-scoped root of the typed worker surface — the worker-side sibling
 * of `TypedClient`.
 *
 * Created with the static {@link TypedWorker.create} factory (the org's
 * `Typed*.create()` shape), it owns the unthrown-disciplined lifecycle —
 * {@link TypedWorker.run | run} and {@link TypedWorker.shutdown | shutdown} —
 * while everything else Temporal's runtime offers (`runUntil`, `getState`,
 * tuning introspection) stays reachable through the
 * {@link TypedWorker.raw | raw} escape hatch.
 */
export class TypedWorker {
  /**
   * The underlying `@temporalio/worker` `Worker` — the escape hatch for
   * anything the typed surface doesn't cover (e.g. `raw.runUntil(...)` in
   * tests, `raw.getState()` for monitoring). Temporal's runtime owns the
   * worker loop; this accessor is always available.
   */
  readonly raw: Worker;

  /** Task queue the worker polls — kept for diagnostics in {@link run}. */
  private readonly taskQueue: string;

  private constructor(worker: Worker, taskQueue: string) {
    this.raw = worker;
    this.taskQueue = taskQueue;
  }

  /**
   * Create a typed Temporal worker with contract-based configuration.
   *
   * This factory simplifies worker creation by:
   * - Using the contract's task queue automatically
   * - Providing type-safe configuration
   *
   * Returns `AsyncResult<TypedWorker, never>` — worker bundling and
   * connection failures are *technical* infrastructure faults, not
   * anticipated domain errors, so they surface on the `Defect` channel (a
   * {@link TechnicalError} instance as the defect's cause) rather than the
   * modeled `Err` channel. The `Err` channel is empty (`never`), so `.get()`
   * unwraps directly — a setup defect rethrows its cause. Alternatively,
   * inspect defects via `match`'s `defect` handler or `recoverDefect` /
   * `tapDefect`.
   *
   * @example
   * ```ts
   * import { NativeConnection } from '@temporalio/worker';
   * import { TypedWorker, workflowsPathFromURL } from '@temporal-contract/worker/worker';
   * import { activities } from './activities.js';
   * import myContract from './contract.js';
   *
   * const connection = await NativeConnection.connect({
   *   address: 'localhost:7233',
   * });
   *
   * const worker = await TypedWorker.create({
   *   contract: myContract,
   *   connection,
   *   workflowsPath: workflowsPathFromURL(import.meta.url, './workflows.js'),
   *   activities,
   * }).get();
   *
   * await worker.run().get();
   * ```
   */
  static create<TContract extends ContractDefinition>(
    options: CreateWorkerOptions<TContract>,
  ): AsyncResult<TypedWorker, never> {
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
    ).map((worker) => new TypedWorker(worker, contract.taskQueue));
  }

  /**
   * Start the worker loop — delegates to the underlying `Worker.run()`.
   *
   * Returns `AsyncResult<void, never>` that resolves `Ok` once the worker has
   * drained and shut down (after {@link shutdown} or a shutdown signal). A
   * worker that fails while running is a *technical* infrastructure fault, so
   * it surfaces on the `Defect` channel (a {@link TechnicalError} instance as
   * the defect's cause) — the returned `AsyncResult` never rejects, so it is
   * safe to hold onto and inspect later. `await worker.run().get()` at the
   * edge rethrows a defect's cause.
   */
  run(): AsyncResult<void, never> {
    return fromPromise(
      // The async wrapper folds a synchronous throw from `run()` (e.g.
      // Temporal's IllegalStateError on a double `run`) into the rejection
      // path, so it is triaged like any other technical fault.
      (async () => {
        await this.raw.run();
      })(),
      (cause, defect) =>
        defect(
          new TechnicalError(
            `Temporal worker for task queue "${this.taskQueue}" failed while running`,
            cause,
          ),
        ),
    );
  }

  /**
   * Initiate a graceful shutdown — delegates to the underlying
   * `Worker.shutdown()`. The worker stops polling, finishes in-flight tasks,
   * and the {@link run} result resolves once draining completes. Calling it
   * on a worker that is not running throws Temporal's `IllegalStateError` —
   * a programming defect, not a modeled error.
   */
  shutdown(): void {
    this.raw.shutdown();
  }
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
 * import { TypedWorker, workflowsPathFromURL } from '@temporal-contract/worker/worker';
 *
 * const worker = await TypedWorker.create({
 *   contract: myContract,
 *   connection,
 *   // Include the extension explicitly to work in both source (.ts) and build (.js) contexts
 *   workflowsPath: workflowsPathFromURL(import.meta.url, './workflows.js'),
 *   activities,
 * }).get();
 * ```
 */
export function workflowsPathFromURL(baseURL: string, relativePath: string): string {
  return fileURLToPath(new URL(relativePath, baseURL));
}
