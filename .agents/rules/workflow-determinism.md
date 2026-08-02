# Workflow Determinism

Workflow code runs inside Temporal's deterministic replay sandbox. Every time a workflow is rehydrated (worker restart, sticky-task reassignment, history replay), Temporal re-runs the implementation from the start and **must produce the exact same sequence of commands**. A desync from history crashes the workflow with a non-determinism error.

**The sandbox does more than people assume.** `@temporalio/workflow/lib/global-overrides.js` rewrites the common hazards before your code runs, and hard-blocks a couple more. So the guidance below is mostly about **semantics, not safety** — the patched APIs work, they just don't mean what their names suggest. Knowing which column a thing is in tells you whether a mistake shows up as a crash, a surprise, or silent corruption.

### Patched — safe, but the semantics differ

These are rewritten in the sandbox. Using them will not break replay. Prefer the explicit primitive anyway, because the behavior is not what the name implies.

| API                          | What it actually does                                                                                                        | Prefer                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `Date.now()` / `new Date()`  | Returns **workflow time** (`getActivator().now`), not wall clock. On replay it returns the historical value.                 | `workflowInfo().startTime` when you mean "when did this start" |
| `Math.random()`              | A **seeded deterministic stream**. Replay-safe, but the sequence shifts when you change consuming code.                      | `uuid4()`, or do RNG in an activity                            |
| `setTimeout` / `setInterval` | Becomes a **durable Temporal timer** wrapped in a cancellation scope. Survives worker restarts; advances with workflow time. | `sleep(duration)` — same thing, honest name                    |

### Blocked loudly — you cannot get this wrong silently

| API                                  | What happens                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `WeakRef` / `FinalizationRegistry`   | Throws `DeterminismViolationError` — "v8 GC is non-deterministic"               |
| `crypto.*`, `fetch`, `fs`, net, disk | Not present in the sandbox context; reference errors rather than nondeterminism |

### Genuinely unprotected — this is where the real risk lives

Nothing patches these. They are the reason this rule exists.

| Hazard                        | Why it bites                                                                                            | Do instead                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `process.env.*`               | Legitimately differs per worker and per deployment. Two workers replaying the same history can diverge. | Pass via `args`, or read in an activity |
| Module-level mutable state    | Shared across executions in a reused VM context; ordering is not yours to control.                      | Keep workflow modules pure              |
| `import.meta.*` / `__dirname` | Environment-dependent, and not something history records.                                               | Constant inputs                         |

The rule of thumb still holds — **if it can return a different value on a second call with the same inputs, it doesn't belong in workflow code** — but note the sandbox already enforces most of it. Spend your vigilance on the third table.

## Why activities can do anything

Activities run _outside_ the sandbox in the regular Node runtime. They can call APIs, hit databases, generate UUIDs, read the wall clock — anything. The activity result becomes part of the workflow's history exactly once, and replay just looks up the recorded result.

That's also why activity inputs/outputs must be serializable (validated through the contract's Standard Schema). Workflow → activity → workflow is the only sanctioned non-deterministic boundary.

## Cancellation primitives are deterministic

Use `context.cancellableScope` / `context.nonCancellableScope` (`packages/worker/src/cancellation.ts:38`, `:75`) — they wrap Temporal's `CancellationScope` and surface cancellation as `Err(WorkflowCancelledError)` in an `AsyncResult`. Don't `try/catch` `CancelledFailure` directly; that bypasses the project's `Result` discipline.

## Side-effect escape hatch

If you need something the sandbox genuinely cannot provide — reading `process.env`, hitting a real clock, calling out — use `LocalActivity` with `proxyLocalActivities` from `@temporalio/workflow`: it runs outside the sandbox like a normal activity, but with lower overhead than a full network round-trip.

Logging via `console.log` is fine in workflow code (`@temporalio/workflow` patches it through Temporal's logger). `console.log({ now: Date.now() })` is fine too — per the first table, that value is workflow time and is stable across replays. What is _not_ fine is `console.log({ env: process.env.REGION })`, because that value can differ between the worker that ran the workflow and the worker that replays it.

## Canonical examples

- `examples/order-processing-worker/src/application/workflows.ts` — uses `context.activities.*` for every effectful call, never reaches for native primitives.
- `packages/worker/src/__tests__/test.workflows.ts` — minimal workflows used in integration tests.
- `packages/worker/src/cancellation.ts:38` — `cancellableScope` implementation showing the `AsyncResult` adapter pattern.
