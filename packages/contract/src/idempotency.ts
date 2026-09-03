/**
 * How a workflow behaves when started again with a workflow ID that has
 * already been used.
 *
 * Named for the *intent* rather than Temporal's enum, which names the
 * mechanism: a reader of `"retry-if-failed"` knows what is protected, where
 * `ALLOW_DUPLICATE_FAILED_ONLY` has to be decoded.
 *
 * This governs the **Closed**-run case only (`workflowIdReusePolicy`). What
 * happens against a *Running* run is `workflowIdConflictPolicy`, which stays
 * a per-call option because different callers legitimately want different
 * answers to "one is already in flight".
 */
export type WorkflowStartPolicy =
  /** This workflow ID may run exactly once, ever. */
  | "once-per-id"
  /** Re-runnable only if the previous attempt did not succeed. */
  | "retry-if-failed"
  /** Temporal's own default. Re-runnable after any Closed state, including Completed. */
  | "allow-duplicate";

/**
 * Temporal's `workflowIdReusePolicy` values, inlined rather than imported.
 *
 * The contract package deliberately carries no `@temporalio/*` dependency —
 * see `DurationValue`'s comment in `types.ts` for the same rationale. The
 * client and worker pass these strings straight through to the SDK, which
 * accepts exactly these literals.
 */
export type WorkflowIdReusePolicy =
  | "ALLOW_DUPLICATE"
  | "ALLOW_DUPLICATE_FAILED_ONLY"
  | "REJECT_DUPLICATE";

/**
 * The single mode→policy mapping. Client and worker both call this so the two
 * cannot drift; `Record<IdempotencyMode, …>` makes a newly added mode a
 * compile error until it is mapped.
 */
const REUSE_POLICY: Record<WorkflowStartPolicy, WorkflowIdReusePolicy> = {
  "once-per-id": "REJECT_DUPLICATE",
  "retry-if-failed": "ALLOW_DUPLICATE_FAILED_ONLY",
  "allow-duplicate": "ALLOW_DUPLICATE",
};

/** Translate a contract's declared idempotency mode to Temporal's policy. */
export function reusePolicyFor(mode: WorkflowStartPolicy): WorkflowIdReusePolicy {
  return REUSE_POLICY[mode];
}

/**
 * @deprecated Renamed to {@link WorkflowStartPolicy}, and the field that
 * carries it from `startPolicy` to `startPolicy`: it governs
 * `workflowIdReusePolicy` — whether a workflow ID may be reused after a
 * Closed run — and never made a workflow idempotent. For an activity running
 * twice under Temporal's at-least-once guarantee, see an activity's
 * `idempotencyKey`.
 */
export type IdempotencyMode = WorkflowStartPolicy;
