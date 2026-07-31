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
 * The candidate is an arbitrary module export, so the property read itself is
 * untrusted: a `Proxy` with a throwing `get` trap, or a function carrying a
 * throwing getter, would otherwise abort the whole registration check with an
 * unrelated exception. Anything that fails to yield a plain string brand —
 * including by throwing — is simply "not a declared workflow".
 *
 * @internal
 */
export function _internal_declaredWorkflowName(candidate: unknown): string | undefined {
  if (typeof candidate !== "function") return undefined;
  let brand: unknown;
  try {
    brand = (candidate as { [DECLARED_WORKFLOW_BRAND]?: unknown })[DECLARED_WORKFLOW_BRAND];
  } catch {
    return undefined;
  }
  return typeof brand === "string" ? brand : undefined;
}
