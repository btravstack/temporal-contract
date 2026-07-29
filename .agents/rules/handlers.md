# Handlers

## Activity Handler

Use `declareActivitiesHandler` with unthrown's `AsyncResult`:

```typescript
import { declareActivitiesHandler, ApplicationFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

export const activities = declareActivitiesHandler({
  contract: myContract,
  activities: {
    validateInventory: (args) =>
      fromPromise(inventoryService.check(args.orderId), (error) =>
        ApplicationFailure.create({
          type: "INVENTORY_CHECK_FAILED",
          message: error instanceof Error ? error.message : "Failed to check inventory",
          ...(error instanceof Error ? { cause: error } : {}),
        }),
      ).map((result) => ({ available: result.inStock })),
  },
});
```

`fromPromise(promise, qualifyFailure)` forces every rejection through `qualifyFailure`, which
returns the modeled error `E` (here an `ApplicationFailure`). For the common
case, the worker package exports a `qualifyFailure(type, options?)` helper that builds
that function — `fromPromise(inventoryService.check(orderId), qualifyFailure("INVENTORY_CHECK_FAILED"))`
preserves an `Error` rejection's message and `cause`, with `options.nonRetryable`
/ `options.details` / `options.message` (non-`Error` fallback) available. For a
value you already have, use `OkAsync(value)` / `ErrAsync(failure)`, or lift an
existing sync `Result` with `Ok(value).toAsync()` / `Err(failure).toAsync()` —
unthrown has no lowercase `okAsync`/`errAsync`.

Canonical example: `examples/order-processing-worker/src/application/activities.ts`.

Implementations receive an optional second **helpers** argument:

- `helpers.errors` — typed constructors for the activity's contract-declared
  `errors` map. `Err(errors.PaymentDeclined({ reason }))` is converted at the
  boundary to `ApplicationFailure(type = "PaymentDeclined", details = [validated data],
nonRetryable from the contract)`, and rehydrated as a typed `ContractError` on the
  workflow side.
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
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async (context, args) => {
    // context.activities — typed, validated activities
    // context.info — WorkflowInfo
    // context.defineSignal/defineQuery/defineUpdate — handler registration
    // context.executeChildWorkflow / context.startChildWorkflow
    // context.cancellableScope / context.nonCancellableScope — see below

    const inventory = await context.activities.validateInventory({ orderId: args.orderId });
    return { status: inventory.available ? "confirmed" : "rejected" };
  },
});
```

Workflow code is deterministic — see [workflow-determinism.md](./workflow-determinism.md) for the banned APIs and replacements.

Typed-error semantics inside the workflow context:

- Activities **without** a declared `errors` map keep the throwing
  `Promise<Output>` shape above.
- Activities **with** a declared `errors` map return
  `AsyncResult<Output, ContractError union | ActivityError | ActivityCancelledError>`
  (mirroring the child-workflow API): declared failures rehydrate into typed
  `ContractError`s, anything else is `Err(ActivityError)` with the unwrapped
  cause, cancellation is `Err(ActivityCancelledError)`.
- `context.errors` holds typed constructors for the workflow's own declared
  errors; `throw context.errors.X(data)` fails the execution as an
  `ApplicationFailure` the typed client rehydrates. Never throw a bare
  `ContractError` constructed by hand — only the context/helpers constructors
  are validated against the declaring contract entry.

## Worker Setup

`createWorker` returns `AsyncResult<Worker, never>` — bundling / connection
failures are _technical_ infrastructure faults, so they ride the **defect**
channel (a `TechnicalError` instance as the cause), not the modeled Err
channel. `activities` is optional — omit it for a workflow-only worker. Same
shape on the client: the connection-scoped `TypedClient.create({ client })`
returns `AsyncResult<TypedClient, never>` (a `TechnicalError`-caused defect on
setup failure); bind a contract with the synchronous, infallible
`typedClient.for(contract)`, which returns a `ContractClient<TContract>` (the
type to use in annotations). There is no `TypedClient.createOrThrow`; the
deprecated `createWorkerOrThrow` still exists for migration.

```typescript
import { createWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";

const workerResult = await createWorker({
  contract: myContract,
  connection,
  workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  activities,
});
if (workerResult.isDefect()) {
  // bundling / connection failure — a TechnicalError-caused defect, not thrown
  process.exit(1);
}

await workerResult.value.run();
```

## Cancellation

Workflows opt into cancellation control via `context.cancellableScope` / `context.nonCancellableScope`. They fold cancellation into the project's `AsyncResult` shape — callers branch on `Err(WorkflowCancelledError)` instead of catching `CancelledFailure`.

```typescript
implementation: async (context, args) => {
  const result = await context.cancellableScope(async () => {
    return context.activities.processStep(args);
  });

  if (result.isErr()) {
    // Workflow was cancelled. Cleanup that must not be cancelled itself
    // goes inside `nonCancellableScope`.
    await context.nonCancellableScope(async () => {
      await context.activities.releaseResources(args);
    });
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

- **Never throw** from activities — Temporal sees thrown errors as `ApplicationFailure(type: "Error", retryable: true)` by default, which masks the real failure type and triggers unwanted retries. Use `Err(ApplicationFailure.create({ type, message, nonRetryable })).toAsync()` (or a `fromPromise(promise, qualifyFailure)` chain whose `qualifyFailure` returns the `ApplicationFailure`) instead.
- **Never use `any`** — use `unknown` and validate with schemas. Enforced by oxlint.
- **Always use `.js` extensions** in imports (even for TypeScript files) — required by ESM module resolution.
- **Don't `try/catch` `CancelledFailure` in workflows** — use `cancellableScope` so cancellation flows through the same `AsyncResult` discipline as everything else.
