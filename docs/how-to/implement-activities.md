# Implement activities

Activities are where side effects happen. `declareActivitiesHandler` takes your
implementations, validates their input and output against the contract, and
produces the plain object Temporal's worker expects.

## The basic shape

```typescript
import { declareActivitiesHandler, qualifyFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

import { orderContract } from "./contract.js";
// Your service clients and their error classes.
import { gateway, GatewayError, mailer, MailerError } from "./services.js";

export const activities = declareActivitiesHandler({
  contract: orderContract,
  activities: {
    // Global activity — declared on the contract, so it sits at the root.
    sendNotification: ({ input: { customerId, message } }) =>
      fromPromise(
        mailer.send(customerId, message),
        qualifyFailure("NOTIFICATION_FAILED", { expected: MailerError }),
      ),

    // Workflow-scoped activities nest under their workflow's name.
    processOrder: {
      chargeCard: ({ input: { customerId, amount } }) =>
        fromPromise(
          gateway.charge(customerId, amount),
          qualifyFailure("CHARGE_FAILED", { expected: GatewayError }),
        ).map((c) => ({
          transactionId: c.id,
        })),
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
fromPromise(promise, qualifyFailure("SOMETHING_FAILED", { expected: SomeSdkError }));
```

`qualifyFailure(type, { expected })` builds a **triaging** qualifier. A
rejection whose cause matches `expected` is _anticipated_: it is wrapped in a
Temporal `ApplicationFailure` whose `type` is the one you declared. Anything
else is an unanticipated bug and rides unthrown's **defect** channel instead —
it re-throws at the activity edge with its original cause, so a `TypeError`
from a typo never masquerades as `SOMETHING_FAILED`.

`expected` is **required** and accepts:

- an error-class constructor (matched with `instanceof`),
- an array of constructors (any match wraps),
- a predicate `(cause: unknown) => boolean`,
- the literal `"any"` — a deliberate, greppable escape hatch that wraps every
  rejection (the pre-v8 blanket behavior).

For a matched `Error` cause, the wrapper keeps the cause's own message and
preserves it as `cause`, so stack traces survive the activity → workflow
boundary; a matched non-`Error` cause falls back to `options.message`, or
`String(cause)`.

```typescript
qualifyFailure("CARD_DECLINED", {
  expected: [CardDeclinedError, GatewayTimeoutError], // the failures you anticipate
  message: "Payment gateway rejected the charge", // used when the cause isn't an Error
  nonRetryable: true, // Temporal stops retrying immediately
  details: [{ gateway: "stripe" }], // structured payload for the workflow
});
```

::: warning A matched cause is always wrapped
Even when the matched rejection is _already_ an `ApplicationFailure`,
`qualifyFailure` wraps it, so the resulting `type` is guaranteed to be the one
you declared — retry policies keyed on `nonRetryableErrorTypes` can rely on
that, and the original failure is preserved as `cause`.

Retryability of the wrapper: an explicit `nonRetryable` option wins
unconditionally; when it is omitted and the matched cause is an
`ApplicationFailure` with `nonRetryable: true`, the wrapper **inherits**
`nonRetryable: true` — a permanent inner failure no longer silently becomes
retryable just because it was re-typed. Pass `nonRetryable: false` to force
the wrapped failure retryable.
:::

For full control, skip `qualifyFailure` and write the qualifier by hand — it
receives the cause and a `defect` callback for the unanticipated branch:

```typescript
fromPromise(gateway.charge(customerId, amount), (error, defect) =>
  error instanceof GatewayError
    ? ApplicationFailure.create({
        type: "CHARGE_FAILED",
        message: error.message,
        nonRetryable: error instanceof PermanentDeclineError,
        cause: error,
      })
    : defect(error),
);
```

`ApplicationFailure` is re-exported from `@temporal-contract/worker/activity`,
so you do not need a separate `@temporalio/common` import.

## Chain steps

`AsyncResult` composes. Each step runs only if the previous one succeeded:

```typescript
processOrder: {
  chargeCard: ({ input: { customerId, amount } }) =>
    fromPromise(
      riskEngine.score(customerId),
      qualifyFailure("RISK_CHECK_FAILED", { expected: RiskEngineError }),
    )
      .flatMap((score) =>
        score > 0.9
          ? ErrAsync(ApplicationFailure.create({ type: "HIGH_RISK", nonRetryable: true }))
          : fromPromise(
              gateway.charge(customerId, amount),
              qualifyFailure("CHARGE_FAILED", { expected: GatewayError }),
            ),
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
`createContext`. Implementations receive it in their first argument, the
helpers record:

```typescript
export const activities = declareActivitiesHandler({
  contract: orderContract,
  createContext: () => ({
    gateway: new StripeGateway(process.env.STRIPE_KEY),
    orders: new OrderRepository(db),
  }),
  activities: {
    processOrder: {
      chargeCard: ({ context, input: { customerId, amount } }) =>
        fromPromise(
          context.gateway.charge(customerId, amount),
          qualifyFailure("CHARGE_FAILED", { expected: GatewayError }),
        ).map((c) => ({ transactionId: c.id })),
    },
  },
});
```

`context` is fully typed from what `createContext` returns. This is the seam to
substitute fakes in tests — see [Test workflows](/how-to/test-workflows).

The helpers record also carries `errors`, the typed constructors for the
activity's declared contract errors. See
[Model domain errors](/how-to/model-domain-errors).

::: tip One record, and a positional shortcut
That is oRPC's shape, which this family converged on, down to its word for the
input: `ProcedureHandlerOptions` carries `input` and the handler still takes it
positionally. So `({ errors, input }) => ...` and `({ errors }, args) => ...` are
the same call. Reach for the record — it is the one that needs no `_`
placeholder when an implementation wants only its input: `({ input }) => ...`.
:::

## Reach Temporal's activity runtime

temporal-contract wraps the contract-shaped parts of an activity; the
`@temporalio/activity` runtime is still available inside the body. Use it for
heartbeats, attempt numbers, and cancellation:

```typescript
import { Context, activityInfo } from "@temporalio/activity";
import { fromPromise } from "unthrown";

processOrder: {
  syncCatalog: ({ input: { pageSize } }) =>
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
      qualifyFailure("CATALOG_SYNC_FAILED", { expected: CatalogError }),
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
  longRunningExport: ({ input }) =>
    fromPromise(runExport(input), (error) => {
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
