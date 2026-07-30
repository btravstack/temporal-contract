# Implement activities

Activities are where side effects happen. `declareActivitiesHandler` takes your
implementations, validates their input and output against the contract, and
produces the plain object Temporal's worker expects.

## The basic shape

```typescript
import { declareActivitiesHandler, qualifyFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

import { orderContract } from "./contract.js";

export const activities = declareActivitiesHandler({
  contract: orderContract,
  activities: {
    // Global activity — declared on the contract, so it sits at the root.
    sendNotification: ({ customerId, message }) =>
      fromPromise(mailer.send(customerId, message), qualifyFailure("NOTIFICATION_FAILED")),

    // Workflow-scoped activities nest under their workflow's name.
    processOrder: {
      chargeCard: ({ customerId, amount }) =>
        fromPromise(gateway.charge(customerId, amount), qualifyFailure("CHARGE_FAILED")).map(
          (c) => ({
            transactionId: c.id,
          }),
        ),
    },
  },
});
```

**The map you write is nested; the handler you get back is flat.** Nesting
mirrors the contract, so autocomplete matches `defineContract` and a
misplaced implementation is a type error. Temporal sees one flat namespace at
runtime, so the wrapper flattens for you.

TypeScript requires _every_ activity in the contract to be implemented. A
missing one is a compile error, not a runtime surprise.

## Turn a promise into a result

Activities return `AsyncResult` instead of throwing. `fromPromise` is the
bridge:

```typescript
fromPromise(promise, qualifyFailure("SOMETHING_FAILED"));
```

`qualifyFailure(type)` builds the error mapper. When the promise rejects it wraps the
rejection in a Temporal `ApplicationFailure`:

- an `Error` rejection keeps its own message and is preserved as `cause`, so
  stack traces survive the activity → workflow boundary;
- anything else falls back to `options.message`, or `String(error)`.

```typescript
qualifyFailure("CARD_DECLINED", {
  message: "Payment gateway rejected the charge", // used when the rejection isn't an Error
  nonRetryable: true, // Temporal stops retrying immediately
  details: [{ gateway: "stripe" }], // structured payload for the workflow
});
```

::: warning `qualifyFailure` always wraps
Even when the rejection is _already_ an `ApplicationFailure`, `qualifyFailure` wraps
it, so the resulting `type` is guaranteed to be the one you declared — retry
policies keyed on `nonRetryableErrorTypes` can rely on that.

The flip side: an inner `ApplicationFailure`'s own `type` and
`nonRetryable: true` are masked. If that inner failure must stay non-retryable,
pass `{ nonRetryable: true }` yourself or write a custom mapper.
:::

For full control, skip `qualifyFailure` and write the mapper by hand:

```typescript
fromPromise(gateway.charge(customerId, amount), (error) =>
  ApplicationFailure.create({
    type: "CHARGE_FAILED",
    message: error instanceof Error ? error.message : "charge failed",
    nonRetryable: error instanceof PermanentDeclineError,
    cause: error instanceof Error ? error : undefined,
  }),
);
```

`ApplicationFailure` is re-exported from `@temporal-contract/worker/activity`,
so you do not need a separate `@temporalio/common` import.

## Chain steps

`AsyncResult` composes. Each step runs only if the previous one succeeded:

```typescript
processOrder: {
  chargeCard: ({ customerId, amount }) =>
    fromPromise(riskEngine.score(customerId), qualifyFailure("RISK_CHECK_FAILED"))
      .flatMap((score) =>
        score > 0.9
          ? ErrAsync(ApplicationFailure.create({ type: "HIGH_RISK", nonRetryable: true }))
          : fromPromise(gateway.charge(customerId, amount), qualifyFailure("CHARGE_FAILED")),
      )
      .map((charge) => ({ transactionId: charge.id })),
}
```

- `.map` transforms a success value.
- `.flatMap` runs another result-returning step and flattens.
- `ErrAsync(...)` builds an already-failed `AsyncResult` (the canonical
  shorthand for `Err(...).toAsync()`); `OkAsync(...)` is its success twin.

## Inject dependencies

Rather than closing over module-scope singletons, seed a typed context with
`createContext`. Implementations receive it as the second argument:

```typescript
export const activities = declareActivitiesHandler({
  contract: orderContract,
  createContext: () => ({
    gateway: new StripeGateway(process.env.STRIPE_KEY),
    orders: new OrderRepository(db),
  }),
  activities: {
    processOrder: {
      chargeCard: ({ customerId, amount }, { context }) =>
        fromPromise(
          context.gateway.charge(customerId, amount),
          qualifyFailure("CHARGE_FAILED"),
        ).map((c) => ({ transactionId: c.id })),
    },
  },
});
```

`context` is fully typed from what `createContext` returns. This is the seam to
substitute fakes in tests — see [Test workflows](/how-to/test-workflows).

The second argument also carries `errors`, the typed constructors for the
activity's declared contract errors. See
[Model domain errors](/how-to/model-domain-errors).

::: tip Implementations that need neither may omit it
`(args) => ...` stays valid. Destructure the helpers only when you use them.
:::

## Reach Temporal's activity runtime

temporal-contract wraps the contract-shaped parts of an activity; the
`@temporalio/activity` runtime is still available inside the body. Use it for
heartbeats, attempt numbers, and cancellation:

```typescript
import { Context, activityInfo } from "@temporalio/activity";
import { fromPromise } from "unthrown";

processOrder: {
  syncCatalog: ({ pageSize }) =>
    fromPromise(
      (async () => {
        const { attempt, heartbeatDetails } = activityInfo();
        let cursor = (heartbeatDetails as string | undefined) ?? null;

        while (true) {
          const page = await catalog.fetch(cursor, pageSize);
          if (page.items.length === 0) break;
          await store.upsert(page.items);
          cursor = page.nextCursor;

          // Report liveness and checkpoint progress; a retry resumes here.
          Context.current().heartbeat(cursor);
        }

        return { synced: true, attempts: attempt };
      })(),
      qualifyFailure("CATALOG_SYNC_FAILED"),
    ),
}
```

A long-running activity that does not heartbeat within its `heartbeatTimeout`
is considered dead and retried from the beginning.

## Handle cancellation

When a workflow is cancelled, in-flight activities receive a cancellation
signal. Let it propagate — do not swallow it:

```typescript
import { CancelledFailure } from "@temporalio/common";

processOrder: {
  longRunningExport: (args) =>
    fromPromise(runExport(args), (error) => {
      if (error instanceof CancelledFailure) {
        throw error; // must propagate, not become a modeled Err
      }
      return ApplicationFailure.create({ type: "EXPORT_FAILED", cause: error as Error });
    }),
}
```

See [Handle cancellation](/how-to/handle-cancellation) for the workflow side.

## What the wrapper does with your result

| Your implementation returns | Temporal sees                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Ok(value)`                 | `value`, after validation against the output schema                                                                              |
| `Err(ApplicationFailure)`   | the failure thrown; retry policy applies                                                                                         |
| `Err(contractError)`        | `data` validated, thrown as `ApplicationFailure` with `type` = error name, `details[0]` = data, `nonRetryable` from the contract |
| a defect (unexpected throw) | the original cause re-thrown, with its stack                                                                                     |

Input is validated before your implementation runs; output is validated after.
An invalid value fails the activity terminally with a `ValidationError` — see
[Validation boundaries](/explanation/validation-boundaries).

## Next

- [Model domain errors](/how-to/model-domain-errors) — typed failures instead
  of string types
- [Add activity middleware](/how-to/add-activity-middleware) — cross-cutting
  logging, auth, metrics
- [Tune activity options](/how-to/tune-activity-options) — timeouts and retries
- [Worker surface](/reference/worker-surface) — the full API
