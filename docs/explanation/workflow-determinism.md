# Workflow determinism

This is the most error-prone area in any Temporal codebase, and the one thing
temporal-contract's type system cannot check for you. It is worth understanding
properly.

## Why replay exists

A Temporal workflow is a durable function. It survives process crashes, worker
restarts, and deployments — not by snapshotting memory, but by **re-running the
function from the beginning** against its recorded history.

When a worker picks up a workflow it has never seen, it executes your
implementation from line one. Every activity call that already completed is
answered instantly from history rather than dispatched again. Once execution
reaches the point where history runs out, the workflow proceeds for real.

That is what makes local variables durable: they are not persisted, they are
_recomputed_.

```typescript
implementation: async (context, order) => {
  let total = 0;                                    // recomputed on replay
  const charge = await context.activities.chargeCard({ ... });  // from history
  total += charge.amount;                           // recomputed identically
  // ...
}
```

## The requirement

For replay to reconstruct the same state, your code must produce **the same
sequence of commands given the same history**. Every time.

If replay takes a different branch — because the wall clock moved, a random
number differed, an environment variable changed — the commands it issues no
longer line up with what was recorded. Temporal detects the divergence and fails
the workflow with a non-determinism error.

The rule of thumb: **if it can return a different value on a second call with
the same inputs, it does not belong in workflow code.**

## What is banned

| Don't                             | Use instead                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `Date.now()`, `new Date()`        | `Date` from `@temporalio/workflow` (patched in the sandbox), or `workflowInfo().startTime` |
| `Math.random()`                   | `uuid4()` from `@temporalio/workflow`, or generate it in an activity                       |
| `crypto.randomUUID()`, `crypto.*` | `uuid4()`, or an activity                                                                  |
| `setTimeout`, `setInterval`       | `sleep(duration)` from `@temporalio/workflow`                                              |
| `process.env.*`                   | Pass via `args`, or read it in an activity                                                 |
| `fetch`, `http`, database, disk   | Wrap in an activity                                                                        |
| `import.meta.*`, `__dirname`      | Constant inputs, or an activity                                                            |

The sandbox patches some of these, so a violation may not fail immediately — it
fails later, on replay, in production. Do not rely on "it worked when I ran it".

## Why activities can do anything

Activities run **outside** the sandbox, in the ordinary Node runtime. They can
call APIs, query databases, generate UUIDs, and read the clock freely.

An activity's result is recorded in history exactly once. On replay, Temporal
looks up the recorded value instead of re-executing. The non-determinism is
captured at a single point and frozen.

That is also why activity inputs and outputs must be serializable — and why
temporal-contract validates them through the contract's schemas. **Workflow →
activity → workflow is the only sanctioned non-deterministic boundary**, so it
is the boundary worth guarding.

## Things that look risky but are fine

**Mutable local state.** Recomputed identically on every replay.

```typescript
let approved = false;
context.defineSignal("approve", () => {
  approved = true;
});
```

**`Promise.all` and concurrency.** Temporal's scheduler is deterministic.

```typescript
const results = await Promise.all(handles.map((h) => h.result()));
```

**Loops and conditionals** over workflow inputs or activity results — all
derived from recorded data.

**`console.log`.** `@temporalio/workflow` patches it through Temporal's logger.
But `console.log({ now: Date.now() })` is _not_ fine — the call is safe, the
**value** is not. Prefer `log` from `@temporalio/workflow`, which is
replay-aware and will not duplicate lines.

## Cancellation stays deterministic

Use `context.cancellableScope` and `context.nonCancellableScope`. They wrap
Temporal's `CancellationScope` and surface cancellation as
`Err(WorkflowCancelledError)`:

```typescript
const result = await context.cancellableScope(() => context.activities.processStep(args));

if (result.isErr()) {
  await context.nonCancellableScope(() => context.activities.releaseResources(args));
  return { status: "cancelled" };
}
```

Catching `CancelledFailure` directly works but bypasses the result discipline
the rest of the codebase uses. See [Handle
cancellation](/how-to/handle-cancellation).

## The escape hatch

For non-determinism inside workflow code that genuinely does not warrant a
network round-trip, use `proxyLocalActivities` from `@temporalio/workflow`. Same
sandboxing rules, lower overhead — the result is still recorded in history.

## Deploying changed workflow code

The subtler failure mode: your code is perfectly deterministic, but you changed
it while executions were still in flight. Old runs replay against the _new_
code and diverge.

Temporal's versioning API handles this:

```typescript
import { patched } from "@temporalio/workflow";

if (patched("add-fraud-check")) {
  await context.activities.scoreRisk({ orderId });  // new path
}
await context.activities.chargeCard({ ... });        // both paths
```

`patched()` returns `true` for new executions and for old ones that already
recorded the patch, and `false` for old executions that did not — so both replay
correctly. Once no pre-patch executions remain, `deprecatePatch()` marks it for
removal.

## What temporal-contract does and does not do

**Does:** validate everything crossing the activity boundary, so the one
sanctioned non-deterministic seam is type-safe and schema-checked; wrap
cancellation in the result model; keep workflow entry points in their own
bundle, so a workflow file that imports a database driver fails to build rather
than failing at runtime.

**Does not:** stop you writing `Date.now()` in a workflow. That is a lint and
review concern. This project enforces it with oxlint rules and a dedicated
contributor rule; adopt something similar in your own codebase.

## Next

- [Architecture](/explanation/architecture) — why workflow code is bundled
  separately
- [Handle cancellation](/how-to/handle-cancellation)
- [Troubleshoot](/how-to/troubleshoot#determinism)
