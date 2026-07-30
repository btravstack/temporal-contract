import { fileURLToPath, pathToFileURL } from "node:url";

// Entry point for worker creation utilities
import { type ContractDefinition } from "@temporal-contract/contract";
import { TechnicalError } from "@temporal-contract/contract/errors";
import { Worker, type WorkerOptions } from "@temporalio/worker";
import { fromPromise, type AsyncResult } from "unthrown";

import type { ActivitiesHandler } from "./activity.js";
import { _internal_declaredWorkflowName } from "./workflow-brand.js";

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

  /**
   * Best-effort startup check that the `workflowsPath` module registers
   * every contract workflow under its declared name. **Defaults to `true`.**
   *
   * Activities already fail fast at `declareActivitiesHandler` time when an
   * implementation is missing; workflows historically did not — a forgotten
   * `declareWorkflow` export surfaced only when the first task for it was
   * dispatched, and an export whose *name* differs from its `workflowName`
   * registered under the wrong workflow type. With this check enabled,
   * `TypedWorker.create` imports the `workflowsPath` module in the main
   * thread, identifies `declareWorkflow`-produced exports via their brand
   * marker, and fails creation (a `TechnicalError`-caused defect) when
   *
   * - a contract workflow has neither a `declareWorkflow`-produced export
   *   nor a plain function export under its name (raw
   *   `@temporalio/workflow`-style workflow functions exported under the
   *   correct name are accepted), or
   * - a declared workflow is exported under a name that differs from its
   *   `workflowName` (Temporal registers workflows by *export name*, so the
   *   mismatch would register it as the wrong workflow type).
   *
   * Best-effort semantics: the check only runs when `workflowsPath` is
   * provided (prebuilt `workflowBundle`s are skipped), and a module that
   * cannot be imported in the main thread is skipped silently — the
   * subsequent `Worker.create` bundling step is the authority on whether the
   * module loads at all. Note the module *is* evaluated in the main thread,
   * so workflow modules should stay side-effect-free at module scope (they
   * should be anyway — the sandbox re-evaluates them constantly).
   *
   * Set to `false` to opt out (e.g. when the workflows module intentionally
   * exports helpers whose names shadow contract workflows, or module-scope
   * evaluation outside the sandbox is undesirable).
   */
  verifyWorkflowRegistration?: boolean;
};

/**
 * Import the workflows module (best-effort) and verify every contract
 * workflow is exported under its declared name. Returns silently when the
 * module cannot be imported in the main thread — `Worker.create`'s bundler
 * is the authority on load failures.
 *
 * @internal
 */
async function verifyWorkflowRegistration(
  contract: ContractDefinition,
  workflowsPath: string,
): Promise<void> {
  let moduleExports: Record<string, unknown>;
  try {
    moduleExports = (await import(pathToFileURL(workflowsPath).href)) as Record<string, unknown>;
  } catch {
    // Best-effort: the module may be main-thread hostile (sandbox-only
    // imports, workflow-bundle-relative paths) or simply not resolvable
    // outside the bundler. Skip — a genuinely broken module fails
    // `Worker.create`'s bundling step with the bundler's own diagnostics.
    return;
  }

  // Map each declared workflowName to the export names it appears under.
  const exportNamesByWorkflow = new Map<string, string[]>();
  for (const [exportName, candidate] of Object.entries(moduleExports)) {
    const declaredName = _internal_declaredWorkflowName(candidate);
    if (declaredName === undefined) continue;
    const names = exportNamesByWorkflow.get(declaredName) ?? [];
    names.push(exportName);
    exportNamesByWorkflow.set(declaredName, names);
  }

  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const workflowName of Object.keys(contract.workflows)) {
    const exportNames = exportNamesByWorkflow.get(workflowName);
    if (!exportNames) {
      // No declareWorkflow-produced export declares this workflow. A plain
      // function exported under the workflow's name still registers
      // correctly (Temporal registers by export name) — workflows written
      // against the raw `@temporalio/workflow` API are a supported pattern,
      // so only flag when neither shape is present.
      if (typeof moduleExports[workflowName] !== "function") {
        missing.push(workflowName);
      }
      continue;
    }
    // Temporal registers workflows by EXPORT name: the declared name must be
    // among the export names, otherwise the workflow registers under the
    // wrong type. (Extra aliases alongside the correct export are tolerated.)
    if (!exportNames.includes(workflowName)) {
      mismatched.push(
        `"${workflowName}" is exported as ${exportNames.map((n) => `"${n}"`).join(", ")}`,
      );
    }
  }

  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(
      `no workflow export${missing.length > 1 ? "s" : ""} (declareWorkflow-produced or plain ` +
        `function) for contract workflow${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
    );
  }
  if (mismatched.length > 0) {
    problems.push(
      `export-name mismatch (Temporal registers workflows by export name, so these would ` +
        `register under the wrong workflow type): ${mismatched.join("; ")}. ` +
        `Export each workflow under its declared workflowName`,
    );
  }
  if (problems.length > 0) {
    // oxlint-disable-next-line unthrown/no-throw -- declaration-time fail-fast config error inside the fromPromise boundary: surfaces as a TechnicalError-caused defect
    throw new TechnicalError(
      `Workflow registration check failed for "${workflowsPath}": ${problems.join(". Also: ")}. ` +
        `(Disable with \`verifyWorkflowRegistration: false\` if this is intentional.)`,
    );
  }
}

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
    const {
      contract,
      activities,
      verifyWorkflowRegistration: verifyRegistration,
      ...workerOptions
    } = options;

    // Create the worker with contract's task queue. `Worker.create` rejects on
    // workflow-bundle compilation errors, bad connections, and invalid
    // options — all *technical* faults, routed to the defect channel with a
    // `TechnicalError` cause (never a modeled `Err`).
    //
    // `activities` is spread conditionally: a workflow-only worker must not
    // pass the key at all (exactOptionalPropertyTypes discipline — and Temporal
    // treats an absent map as "don't poll for Activity Tasks").
    return fromPromise(
      (async () => {
        // Registration completeness check (default on) — only meaningful
        // when a `workflowsPath` module is supplied; prebuilt
        // `workflowBundle`s are skipped. See the option's JSDoc.
        if ((verifyRegistration ?? true) && typeof workerOptions.workflowsPath === "string") {
          await verifyWorkflowRegistration(contract, workerOptions.workflowsPath);
        }
        return Worker.create({
          ...workerOptions,
          ...(activities !== undefined ? { activities } : {}),
          taskQueue: contract.taskQueue,
        });
      })(),
      (cause, defect) =>
        defect(
          cause instanceof TechnicalError
            ? cause
            : new TechnicalError(
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
