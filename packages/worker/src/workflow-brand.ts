/**
 * Brand marker shared between `declareWorkflow` (which stamps it) and
 * `TypedWorker.create`'s workflow-registration check (which reads it). Kept
 * in a leaf module so the `worker` entry point doesn't have to import the
 * whole workflow surface (and its `@temporalio/workflow` dependency) just to
 * read the brand.
 */

/**
 * Brand key marking functions produced by `declareWorkflow`.
 * `Symbol.for` (not a private symbol) so the marker survives duplicated
 * module instances — the worker's registration check may import the
 * workflows module in the main thread while the workflow bundle carries its
 * own copy of this package.
 *
 * @internal
 */
export const DECLARED_WORKFLOW_BRAND = Symbol.for("temporal-contract.declareWorkflow");

/**
 * Read the `workflowName` a `declareWorkflow`-produced function was declared
 * with, or `undefined` for anything else. Used by `TypedWorker`'s
 * workflow-registration completeness check.
 *
 * @internal
 */
export function _internal_declaredWorkflowName(candidate: unknown): string | undefined {
  if (typeof candidate !== "function") return undefined;
  const brand = (candidate as { [DECLARED_WORKFLOW_BRAND]?: unknown })[DECLARED_WORKFLOW_BRAND];
  return typeof brand === "string" ? brand : undefined;
}
