/**
 * Helpers behind the `./test-rig`, `./extension` and `./contract` entries. Not a
 * package entry point: the entries import from here, and the unit specs
 * import from here directly, so none of it leaks into the public surface.
 */
import { inject } from "vitest";

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

/**
 * Whether a workflow-execution status names a finished run, and is therefore
 * safe to fetch and replay. An unscoped `handle.describe()` (no `runId`)
 * always resolves to the *latest* run in a chain, so in practice it can
 * never itself report `CONTINUED_AS_NEW` — that status only ever shows up if
 * a caller describes a specific older run directly. It's kept in the set
 * anyway because it genuinely is a finished, replayable state for whichever
 * run it's read from.
 */
export function isTerminalStatus(name: string): boolean {
  return TERMINAL_STATUSES.has(name);
}

/**
 * Look up the caller-supplied `replaySkipAllowlist` reason for a
 * non-terminal execution, matching by workflow-ID *prefix* so one entry
 * covers every workflow ID `nextTaskQueueId`-style counters generate from a
 * shared base (e.g. `"probe-edge-cases"` matches `"probe-edge-cases-1"`,
 * `"probe-edge-cases-2"`, ...). Returns `undefined` for anything unlisted,
 * so the caller can fail loudly instead of silently under-reporting replay
 * coverage.
 */
export function skipReasonFor(
  workflowId: string,
  allowlist: Readonly<Record<string, string>>,
): string | undefined {
  // Longest match wins, not first. `Object.entries` order would otherwise make
  // overlapping prefixes ("order" and "order-cancel") resolve to whichever was
  // declared first — so the same workflow ID could pick up a different reason
  // purely from key ordering, and a deliberately narrower entry could be
  // shadowed by a broader one.
  let best: { prefix: string; reason: string } | undefined;
  for (const [prefix, reason] of Object.entries(allowlist)) {
    if (!workflowId.startsWith(prefix)) continue;
    if (best === undefined || prefix.length > best.prefix.length) best = { prefix, reason };
  }
  return best?.reason;
}

/**
 * The `ContractClient` methods that can start an execution. Pinned against
 * `ContractClient`'s actual method surface by a unit test in
 * `test-rig.spec.ts`; guarded again at runtime inside `testRig` itself,
 * since a unit test only catches drift when someone remembers to run it.
 */
export const START_METHODS = new Set([
  "startWorkflow",
  "executeWorkflow",
  "signalWithStart",
  "executeUpdateWithStart",
]);

/**
 * `JSON.stringify` for a diagnostic message, but never at the cost of the
 * diagnostic. A bag containing a BigInt (or a circular reference) makes
 * `JSON.stringify` throw, which would replace the guard's actionable error
 * with an unrelated TypeError — hiding exactly the problem it exists to
 * surface. Falls back to a coarse description.
 */
function describeBag(bag: unknown): string {
  try {
    return JSON.stringify(bag) ?? String(bag);
  } catch {
    return `[unserializable ${typeof bag}]`;
  }
}

/**
 * Pull the `workflowId` out of a start method's options bag (its second
 * argument, per every `START_METHODS` signature) so the rig knows which
 * execution to replay later. Returns `undefined` when the bag omits it and
 * the workflow's contract derives the ID (`derivesId`) — the caller then
 * resolves it with `workflowIdFor`.
 *
 * Throwing when neither holds is deliberate: the alternative is the rig
 * silently recording nothing, `onTestFinished` iterating nothing, and the
 * test passing green while proving zero replay coverage — exactly the
 * failure mode the rig exists to prevent.
 */
export function extractStartedWorkflowId(
  methodName: string,
  args: readonly unknown[],
  derivesId = false,
): string | undefined {
  const bag = args[1];
  const workflowId =
    typeof bag === "object" && bag !== null && "workflowId" in bag
      ? (bag as { workflowId?: unknown }).workflowId
      : undefined;
  if (typeof workflowId === "string") return workflowId;
  if (derivesId && workflowId === undefined) return undefined;
  // oxlint-disable-next-line unthrown/no-throw -- test-harness assertion: guards the rig's one load-bearing assumption about ContractClient's call shape; see this function's JSDoc
  throw new Error(
    `testRig expected "${methodName}"'s second argument to carry a string "workflowId" ` +
      `(required unless the contract derives it) but received: ${describeBag(bag)}. ` +
      `Without it, this execution's history can never be harvested for replay.`,
  );
}

/**
 * Join the host/port pair injected by the testcontainers global setup into a
 * Temporal address, failing with a descriptive error when the global setup
 * was never registered (in which case `inject` yields `undefined` and the
 * fixtures would otherwise try to connect to `"undefined:undefined"`).
 */
export function resolveTemporalAddress(host: string | undefined, port: number | undefined): string {
  if (host === undefined || port === undefined) {
    // oxlint-disable-next-line unthrown/no-throw -- declaration-time fail-fast config error: missing global-setup injection must abort the test run with a descriptive message
    throw new Error(
      "Temporal test-server address was not injected into this test project. " +
        'Register the testcontainers global setup in your vitest config — globalSetup: "@temporal-contract/testing/global-setup" ' +
        "(or a module default-exporting createGlobalSetup(...)) — so the fixtures from @temporal-contract/testing know where to connect.",
    );
  }
  return `${host}:${port}`;
}

/** The Temporal address injected by the testcontainers global setup. */
export function getTemporalAddress(): string {
  // The ProvidedContext augmentation types these keys as always present, but
  // at runtime they are only there when the global setup actually ran.
  return resolveTemporalAddress(
    inject("__TESTCONTAINERS_TEMPORAL_IP__") as string | undefined,
    inject("__TESTCONTAINERS_TEMPORAL_PORT_7233__") as number | undefined,
  );
}
