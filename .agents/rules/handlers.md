# Handlers

## Activity Handler

Use `declareActivitiesHandler` with unthrown's `AsyncResult`:

```typescript
import { declareActivitiesHandler, ApplicationFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

export const activities = declareActivitiesHandler({
  contract: myContract,
  activities: {
    validateInventory: ({ input }) =>
      fromPromise(inventoryService.check(input.orderId), (error) =>
        ApplicationFailure.create({
          type: "INVENTORY_CHECK_FAILED",
          message: error instanceof Error ? error.message : "Failed to check inventory",
          ...(error instanceof Error ? { cause: error } : {}),
        }),
      ).map((result) => ({ available: result.inStock })),
  },
});
```

`fromPromise(promise, qualify)` forces every rejection through `qualify`, which
returns the modeled error `E` (here an `ApplicationFailure`) or routes the cause
to the defect channel. For the common case, the worker package exports a
`qualifyFailure(errorType, options)` helper that builds that function —
`options.expected` is **required** (an error-class constructor, an array of
them, a predicate, or the literal `"any"` escape hatch): matching causes are
wrapped (preserving an `Error` rejection's message and `cause`, and inheriting
`nonRetryable: true` from a matched non-retryable `ApplicationFailure` unless
`options.nonRetryable` overrides), everything else becomes a defect. E.g.
`fromPromise(inventoryService.check(orderId), qualifyFailure("INVENTORY_CHECK_FAILED", { expected: InventoryServiceError }))`.
`options.details` / `options.message` (non-`Error` fallback) remain available. For a
value you already have, use the canonical pre-lifted constructors
`OkAsync(value)` / `ErrAsync(failure)` (prefer `OkAsync()` zero-arg over
`OkAsync(undefined)`); `.toAsync()` is for lifting a sync `Result` you already
hold, not for direct construction — unthrown has no lowercase
`okAsync`/`errAsync`.

Canonical example: `examples/order-processing-worker/src/application/activities.ts`.

Implementations take **helpers first, input second** — oRPC's shape, which this
family converged on: its `ProcedureHandlerOptions` carries `input` and the
handler still takes it positionally, so `({ errors, args }) => ...` and
`({ errors }, args) => ...` are the same call — oRPC has both. Reach for the
record: a leaf that consumes neither typed errors nor injected context is
`({ input }) => ...`. The record carries:

- `helpers.errors` — typed constructors for the activity's contract-declared
  `errors` map. `Err(errors.PaymentDeclined({ reason }))` is converted at the
  boundary to `ApplicationFailure(type = "PaymentDeclined", details = [validated data],
nonRetryable from the contract)`, and rehydrated as a typed `ContractError` on the
  workflow side.
- `helpers.input` — the validated input, the same value the second parameter
  carries. `input` is oRPC's word for it, and the same name on all three
  transports is the point.
- `helpers.context` — the accumulated typed context: the seed built by
  `declareActivitiesHandler`'s optional `createContext` factory (runs once per
  activity execution with `{ activityName, workflowName }`) plus everything
  injected by the middleware chain via `next({ context })`.

`declareActivitiesHandler` also accepts `middleware` — a single
`ActivityMiddleware` or a typed chain built with
`composeActivityMiddleware(...)` (outermost-first, inside the validation
boundary, operating on the `AsyncResult` — not thrown exceptions). Middleware
accumulates context with bounded generics (`TContextOut extends TContextIn`,
amqp-contract's model): `next({ context })` extends what downstream stages and
the implementation see; `next({ input })` substitutes the input (re-validated).
The client has the mirror-image seam: `TypedClient.create({ interceptors })`
wraps start/execute/signalWithStart and handle-level signal/query/update.

## Workflow Declaration

Use `declareWorkflow` for type-safe workflow implementation:

```typescript
import { declareWorkflow } from "@temporal-contract/worker/workflow";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract: myContract,
  activityOptions: { startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3 } },
  implementation: async (context, args) => {
    // context.activities — typed, validated activities
    // context.info — WorkflowInfo
    // context.handleSignal/handleQuery/handleUpdate — handler binding
    // context.executeChildWorkflow / context.startChildWorkflow
    // context.cancellableScope / context.nonCancellableScope — see below

    const inventory = await context.activities.validateInventory({ orderId: args.orderId });
    if (inventory.isDefect()) {
      throw inventory.cause;
    }
    if (inventory.isErr()) {
      return { status: "rejected" };
    }
    return { status: inventory.value.available ? "confirmed" : "rejected" };
  },
});
```

Every reachable activity's MERGED options (`activityOptions` →
`defineActivity({ activityOptions })` → `activityOptionsByName`, shallow
merge) need both a per-attempt bound and a total bound, and every child
workflow call needs an explicit `parentClosePolicy` — see
[worker-surface.md](../../docs/reference/worker-surface.md)'s "Activity
bounds" and "Required `parentClosePolicy`" sections for the exact rules,
including the shallow-merge trap and the `maximumAttempts` edge cases.

The two are enforced by different machinery, and the difference matters:
`parentClosePolicy` is **type-only** — omitting it (or passing `undefined`) is
a compile error, and there is no runtime check. The activity bounds are a
**runtime** check inside `declareWorkflow`, which runs at module top level, so
a violation stalls the workflow via workflow-task retry rather than failing it
— see that reference for why that is deliberate.

Workflow code is deterministic — see [workflow-determinism.md](./workflow-determinism.md) for the banned APIs and replacements.

Typed-error semantics inside the workflow context:

- **Every** activity call returns `AsyncResult` — declared `errors` map or
  not. There is no throwing `Promise<Output>` shape anymore; narrow the
  result with `isOk()`/`isErr()`, or use `propagateActivityFailure` to let
  the failure escape and have Temporal decide the workflow's outcome. A bare
  `await context.activities.x(...)` compiles either way — it's easy to
  discard the `AsyncResult` by accident and silently swallow a failure.
  **Never** use unthrown's `.getOrThrow()` here: it throws the
  `ActivityError`/`ActivityCancelledError` wrapper, which is a `TaggedError`
  and not a `TemporalFailure` — Temporal retries that as a workflow-_task_
  failure indefinitely instead of failing the workflow.
- Activities **with** a declared `errors` map return
  `AsyncResult<Output, ContractError union | ActivityError | ActivityCancelledError>`
  (mirroring the child-workflow API): declared failures rehydrate into typed
  `ContractError`s, anything else is `Err(ActivityError)` with the unwrapped
  cause, cancellation is `Err(ActivityCancelledError)`. Activities
  **without** a declared `errors` map return
  `AsyncResult<Output, ActivityError | ActivityCancelledError>` — same
  shape, minus the declared-error members.
- `context.errors` holds typed constructors for the workflow's own declared
  errors; `throw context.errors.X(data)` fails the execution as an
  `ApplicationFailure` the typed client rehydrates. Never throw a bare
  `ContractError` constructed by hand — only the context/helpers constructors
  are validated against the declaring contract entry.

## Worker Setup

`TypedWorker.create(options)` — the org's `Typed*.create()` factory shape,
mirroring `TypedClient.create` — returns `AsyncResult<TypedWorker, never>`:
bundling / connection failures are _technical_ infrastructure faults, so they
ride the **defect** channel (a `TechnicalError` instance as the cause), not
the modeled Err channel. `activities` is optional — omit it for a
workflow-only worker. Same shape on the client: the connection-scoped
`TypedClient.create({ client })` returns `AsyncResult<TypedClient, never>` (a
`TechnicalError`-caused defect on setup failure); bind a contract with the
synchronous, infallible `typedClient.for(contract)`, which returns a
`ContractClient<TContract>` (the type to use in annotations). There is no
`TypedClient.createOrThrow`, no `createWorker`, and no `createWorkerOrThrow`
— use `.get()` on the returned `AsyncResult`.

`TypedWorker` owns the unthrown-disciplined lifecycle: `run()` returns
`AsyncResult<void, never>` (a mid-run crash is a `TechnicalError`-caused
defect; the internal promise never rejects) and `shutdown()` initiates a
graceful drain. Everything else Temporal offers (`runUntil`, `getState`)
lives on the raw escape hatch `worker.raw`.

```typescript
import { TypedWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";

const workerResult = await TypedWorker.create({
  contract: myContract,
  connection,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities,
});
if (workerResult.isDefect()) {
  // bundling / connection failure — a TechnicalError-caused defect, not thrown
  process.exit(1);
}

await workerResult.get().run().get();
```

## Cancellation

Workflows opt into cancellation control via `context.cancellableScope` / `context.nonCancellableScope`. They fold cancellation into the project's `AsyncResult` shape — callers branch on `Err(WorkflowCancelledError)` instead of catching `CancelledFailure`.

```typescript
implementation: async (context, args) => {
  // `fn`'s return value becomes the scope's `T` verbatim, so await and
  // narrow the activity's own AsyncResult HERE, inside the callback —
  // returning it un-awaited would make `T` the AsyncResult itself, which
  // has no `isOk`/`isErr`/`.value`.
  const result = await context.cancellableScope(async () => {
    const step = await context.activities.processStep(args);
    if (step.isDefect()) {
      throw step.cause;
    }
    return step.isOk();
  });

  if (result.isDefect()) {
    throw result.cause; // a genuine bug thrown inside the scope, not a cancel
  }
  if (result.isErr()) {
    // Workflow was cancelled. Cleanup that must not be cancelled itself
    // goes inside `nonCancellableScope`. Capture ITS OWN AsyncResult too —
    // a bare `await` would silently discard both a defect thrown during
    // cleanup and the un-awaited activity result.
    const released = await context.nonCancellableScope(async () => {
      const step = await context.activities.releaseResources(args);
      if (step.isErr()) {
        // best-effort cleanup — log and continue regardless
      }
    });
    if (released.isDefect()) {
      throw released.cause; // a genuine bug in cleanup, not a cancel
    }
    return { status: "cancelled" };
  }

  return { status: "ok" };
};
```

- `cancellableScope<T>(fn)` — returns `AsyncResult<T, WorkflowCancelledError>`. Cancels propagate from outside.
- `nonCancellableScope<T>(fn)` — same shape; _outside_ cancels are ignored. Cancels raised _inside_ still surface as `Err(...)`. Use for graceful-shutdown cleanup.
- Non-cancellation errors thrown by `fn` are _unmodeled_ failures: they ride unthrown's **`defect`** channel (inspectable via `result.isDefect()` / `result.cause`, re-thrown at the edge), not the modeled `err` channel.

Canonical implementation: `packages/worker/src/cancellation.ts:38` (`cancellableScope`), `:75` (`nonCancellableScope`). Error class: `packages/worker/src/errors.ts:193`.

## ApplicationFailure semantics

`ApplicationFailure` (re-exported from `@temporal-contract/worker/activity`) is Temporal's first-class failure type. The wrapper at `packages/worker/src/activity.ts:8-15` rethrows the `Err(...)` payload at the activity boundary, where Temporal recognizes it natively and applies the configured retry policy.

Fields that matter:

| Field          | What it does                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`         | Discriminator. Used by callers (and retry policies via `retry.nonRetryableErrorTypes`) to branch. Required-in-spirit.                      |
| `message`      | Human-readable. Surfaced in Temporal UI.                                                                                                   |
| `nonRetryable` | `true` → Temporal stops retrying this attempt immediately. Use for permanent failures (validation rejection, insufficient funds).          |
| `cause`        | Wraps the underlying `Error`. Always set when wrapping a thrown exception so stack traces survive across the activity → workflow boundary. |
| `details`      | Structured payload (array). Useful for passing context to the workflow without parsing `message`.                                          |

```typescript
ApplicationFailure.create({
  type: "PAYMENT_DECLINED",
  message: "Card declined: insufficient funds",
  nonRetryable: true, // Don't retry — user must change payment method
  details: [{ reason: "insufficient_funds", attemptId: "..." }],
});
```

`WorkflowFailedError` (`packages/client/src/errors.ts`) wraps this on the client side: its `.cause` field is the original `ApplicationFailure` so callers can `instanceof`-check the cause directly.

## Anti-patterns

- **Never throw** from activities — Temporal sees thrown errors as `ApplicationFailure(type: "Error", retryable: true)` by default, which masks the real failure type and triggers unwanted retries. Use `ErrAsync(ApplicationFailure.create({ type, message, nonRetryable }))` (or a `fromPromise(promise, qualifyFailure)` chain whose `qualifyFailure` returns the `ApplicationFailure`) instead.
- **Never use `any`** — use `unknown` and validate with schemas. Enforced by oxlint.
- **Always use `.js` extensions** in imports (even for TypeScript files) — required by ESM module resolution.
- **Don't `try/catch` `CancelledFailure` in workflows** — use `cancellableScope` so cancellation flows through the same `AsyncResult` discipline as everything else.
