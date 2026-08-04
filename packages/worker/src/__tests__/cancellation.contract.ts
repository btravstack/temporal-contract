import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

// Composition-first: resources are defined individually, then composed into
// the contract (never inlined in `defineContract`).

/**
 * A real (wall-clock) `setTimeout`-backed activity, declared at the
 * CONTRACT ROOT so it is reachable from every workflow below without being
 * re-listed per workflow (mirrors `globalTimeoutActivity` in
 * `activity-options.contract.ts`).
 *
 * Every activity call — this one included — is on the `AsyncResult` path
 * (`activities-proxy.ts`'s `makeResultShapedActivity` wraps all of them, not
 * just ones with a declared `errors` map). That uniform path is precisely
 * the condition that creates the swallowed-cancellation hazard under test: a
 * cancelled in-flight activity call resolves to `Err(ActivityCancelledError)`
 * — a value on the SAME modeled channel as an ordinary declared failure, and
 * therefore indistinguishable from one to a handler that maps every `Err` to
 * a generic fallback. The empty `errors: {}` here is incidental (it only
 * types the declared-error member of the union as `never`), not what puts
 * the call on the `AsyncResult` path.
 */
const slowActivity = defineActivity({
  input: z.object({ sleepMs: z.number() }),
  output: z.object({ done: z.boolean() }),
  errors: {},
  // `heartbeatTimeout` matters here beyond liveness: Temporal only delivers
  // a cancellation notification to an activity that heartbeats (the
  // notification rides the heartbeat RPC's response) — see
  // `@temporalio/activity`'s `Context.cancelled` doc. Without it, the
  // cancellable-activity tests below could not observe cancellation at all.
  //
  // `retry: { maximumAttempts: 1 }` mirrors every activity in
  // `activity-options.contract.ts`. Verified empirically (not just assumed):
  // an always-failing implementation with NO cap still resolved in under a
  // second under the time-skipping server, which — like workflow timers —
  // skips retry backoff delay entirely, so an unbounded retry loop does not
  // itself produce a WALL-CLOCK hang in this test tier. The cap earns its
  // place anyway: it (a) matches the sibling contract's own precedent so
  // this file isn't a silent outlier, and (b) gives a single, precise
  // failure instead of leaving this activity's actual attempt count to
  // Temporal's default (unbounded) policy — which is exactly the kind of
  // implicit behavior this suite's assertions should not depend on.
  activityOptions: {
    startToCloseTimeout: "30 seconds",
    heartbeatTimeout: "5 seconds",
    retry: { maximumAttempts: 1 },
  },
});

/**
 * Calls `slowActivity` and folds a cancelled call into a GENERIC fallback —
 * the hazard: nothing distinguishes `ActivityCancelledError` from any other
 * declared failure, so a real cancellation request is silently absorbed and
 * the execution completes normally.
 */
const swallowsCancellation = defineWorkflow({
  input: z.object({}),
  output: z.object({ status: z.string() }),
  idempotency: "allow-duplicate",
});

/**
 * Same shape as `swallowsCancellation`, but the fix: it recognizes
 * `ActivityCancelledError` specifically and re-raises it via
 * `rethrowCancellation`, so the execution ends `Cancelled` instead of
 * `Completed`.
 */
const honorsCancellation = defineWorkflow({
  input: z.object({}),
  output: z.object({ status: z.string() }),
  idempotency: "allow-duplicate",
});

/**
 * Wraps the same activity call in `nonCancellableScope`, so an outer cancel
 * request is ignored for the scope's duration and the workflow runs to
 * completion regardless.
 */
const nonCancellableWorkflow = defineWorkflow({
  input: z.object({}),
  output: z.object({ status: z.string() }),
  idempotency: "allow-duplicate",
});

/**
 * Direct, no-activity coverage of `context.cancellableScope` /
 * `context.nonCancellableScope`'s own Result-folding mechanics (success /
 * defect / internally-raised cancellation) — the behaviors the OLD mocked
 * `cancellation.spec.ts` asserted via a faked `CancellationScope` and a
 * faked `isCancellation`. Deterministic (no timers, no activities), so
 * every mode resolves in a single Workflow Task — no real-time wait needed.
 */
const scopeMode = z.enum([
  "cancellable-ok",
  "cancellable-defect",
  "noncancellable-ok",
  "noncancellable-defect",
  "noncancellable-internal-cancel",
]);

const scopeMechanics = defineWorkflow({
  input: z.object({ mode: scopeMode }),
  output: z.object({ outcome: z.string() }),
  idempotency: "allow-duplicate",
});

export const cancellationContract = defineContract({
  taskQueue: "cancellation-tests",
  activities: { slowActivity },
  workflows: {
    swallowsCancellation,
    honorsCancellation,
    nonCancellableWorkflow,
    scopeMechanics,
  },
});
