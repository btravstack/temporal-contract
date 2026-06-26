# Workflow Determinism

Workflow code runs inside Temporal's deterministic replay sandbox. Every time a workflow is rehydrated (worker restart, sticky-task reassignment, history replay), Temporal re-runs the implementation from the start and **must produce the exact same sequence of commands**. Any non-determinism — wall-clock reads, native randomness, direct I/O — will desync from history and crash the workflow with a non-determinism error.

This is THE most error-prone area in any Temporal codebase. Read it.

## Banned in workflow code

| Don't                              | Use instead                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `Date.now()` / `new Date()`        | `workflowInfo().startTime` or `Date` from `@temporalio/workflow` (it's monkey-patched in the sandbox) |
| `Math.random()`                    | `uuid4()` from `@temporalio/workflow`, or do RNG inside an activity                                   |
| `crypto.randomUUID()` / `crypto.*` | `uuid4()` from `@temporalio/workflow`, or activity                                                    |
| `setTimeout` / `setInterval`       | `sleep(duration)` from `@temporalio/workflow`                                                         |
| `process.env.*`                    | Pass via `args` or read inside an activity                                                            |
| `fetch` / `http` / database / disk | Wrap in an activity — workflows must not touch I/O                                                    |
| `import.meta.*` / `__dirname`      | Constant inputs; or read inside an activity                                                           |

The rule of thumb: **if it can return a different value on a second call with the same inputs, it doesn't belong in workflow code.** Push it into an activity, where retries and non-determinism are explicitly handled.

## Why activities can do anything

Activities run _outside_ the sandbox in the regular Node runtime. They can call APIs, hit databases, generate UUIDs, read the wall clock — anything. The activity result becomes part of the workflow's history exactly once, and replay just looks up the recorded result.

That's also why activity inputs/outputs must be serializable (validated through the contract's Standard Schema). Workflow → activity → workflow is the only sanctioned non-deterministic boundary.

## Cancellation primitives are deterministic

Use `context.cancellableScope` / `context.nonCancellableScope` (`packages/worker/src/cancellation.ts:38`, `:75`) — they wrap Temporal's `CancellationScope` and surface cancellation as `err(WorkflowCancelledError)` in an `AsyncResult`. Don't `try/catch` `CancelledFailure` directly; that bypasses the project's `Result` discipline.

## Side-effect escape hatch

If you absolutely need non-determinism inside workflow code (e.g. logging at a checkpoint), use `LocalActivity` with `proxyLocalActivities` from `@temporalio/workflow` — same sandboxing rules but lower overhead than a full network round-trip. Even logging via `console.log` is fine in workflow code (`@temporalio/workflow` patches it through Temporal's logger), but `console.log({ now: Date.now() })` is not — the _value_ is non-deterministic.

## Canonical examples

- `examples/order-processing-worker/src/application/workflows.ts` — uses `context.activities.*` for every effectful call, never reaches for native primitives.
- `packages/worker/src/__tests__/test.workflows.ts` — minimal workflows used in integration tests.
- `packages/worker/src/cancellation.ts:38` — `cancellableScope` implementation showing the `AsyncResult` adapter pattern.
