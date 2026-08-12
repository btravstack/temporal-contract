# Add activity middleware

Middleware wraps every activity implementation in a contract. Use it for
cross-cutting concerns — logging, metrics, authorization, dependency injection
— without touching each implementation.

## Where middleware sits

```
                  ┌─────────────────────────────────┐
  input   ──────▶ │  validated against input schema │
                  └────────────────┬────────────────┘
                                   ▼
                        ┌─────────────────────┐
                        │  middleware chain   │  ← runs here
                        └──────────┬──────────┘
                                   ▼
                        ┌─────────────────────┐
                        │  implementation     │
                        └──────────┬──────────┘
                                   ▼
                  ┌─────────────────────────────────┐
  output  ◀────── │ validated against output schema │
                  └─────────────────────────────────┘
```

Middleware runs **inside** the validation boundary: `invocation.input` is
already validated, and whatever the chain returns on the `ok` channel is still
validated on the way out. Because it operates on `AsyncResult` rather than
thrown exceptions, it observes modeled failures on the `err` channel and can
short-circuit without calling `next`.

## Log every invocation

```typescript
import {
  ApplicationFailure,
  declareActivitiesHandler,
  type ActivityMiddleware,
} from "@temporal-contract/worker/activity";
import { P } from "unthrown";

const logging: ActivityMiddleware = ({ activityName, workflowName }, next) =>
  next().tapErrCases((matcher) =>
    matcher.with(
      P.instanceOf(ApplicationFailure),
      P.tag("@temporal-contract/ContractError"),
      (error) => {
        logger.warn({ activityName, workflowName, error }, "activity failed");
      },
    ),
  );

export const activities = declareActivitiesHandler({
  contract: orderContract,
  middleware: logging,
  activities: {/* ... */},
});
```

`invocation` carries `activityName` (the flat runtime name) and `workflowName`
(the owning workflow, or `undefined` for a global activity).

## Inject typed context

The most useful thing middleware does is extend the typed context that flows to
implementations. Use `declareActivityMiddleware` to pin the in and out types:

```typescript
import {
  ApplicationFailure,
  declareActivityMiddleware,
  type EmptyContext,
} from "@temporal-contract/worker/activity";
import { ErrAsync } from "unthrown";

const withTenant = declareActivityMiddleware<EmptyContext, { tenantId: string }>(
  (invocation, next) => {
    const tenantId = (invocation.input as { tenantId?: string }).tenantId;

    if (!tenantId) {
      // Short-circuit: never calls next().
      return ErrAsync(ApplicationFailure.create({ type: "Unauthenticated", nonRetryable: true }));
    }

    return next({ context: { tenantId } });
  },
);
```

Downstream, implementations see it typed:

```typescript
export const activities = declareActivitiesHandler({
  contract: orderContract,
  middleware: withTenant,
  activities: {
    processOrder: {
      chargeCard: ({ customerId, amount }, { context }) =>
        // context.tenantId: string
        fromPromise(
          gateway.charge(context.tenantId, customerId, amount),
          // `expected` is required: name the anticipated failure class (or a
          // predicate). Everything else rides the defect channel.
          qualifyFailure("CHARGE_FAILED", { expected: GatewayError }),
        ),
    },
  },
});
```

Context patches shallow-merge, so later middleware and the implementation see
everything accumulated so far.

## Compose a chain

`composeActivityMiddleware` threads the context types through — each
middleware's output context bounds the next one's input:

```typescript
import { composeActivityMiddleware } from "@temporal-contract/worker/activity";

export const activities = declareActivitiesHandler({
  contract: orderContract,
  createContext: () => ({ requestId: crypto.randomUUID() }),
  middleware: composeActivityMiddleware(
    logging, // outermost
    withTenant, // adds { tenantId }
    withDatabase, // adds { db }, may read tenantId
  ),
  activities: {/* implementations see requestId, tenantId, and db */},
});
```

The first argument is outermost. Overloads cover up to eight; for longer chains,
nest — a composed chain is itself an `ActivityMiddleware` and can be the first
argument of an outer `composeActivityMiddleware` call.

## Seed the context

`createContext` supplies the value the outermost middleware receives. It is also
usable on its own, with no middleware at all, as plain dependency injection:

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
          qualifyFailure("CHARGE_FAILED", { expected: GatewayError }),
        ),
    },
  },
});
```

## Substitute the input

`next({ input })` replaces the input flowing downstream. The substitution is
**re-validated** against the activity's input schema, so middleware cannot
smuggle unvalidated data past the contract:

```typescript
const normalizeEmail = declareActivityMiddleware((invocation, next) => {
  const input = invocation.input as { email?: string };
  if (typeof input.email !== "string") {
    return next();
  }
  return next({ input: { ...input, email: input.email.trim().toLowerCase() } });
});
```

An invalid substitution fails terminally with `ActivityInputValidationError`.

## Retry inside middleware

Because `next` can be called more than once, a retry is just a branch on the
error channel:

```typescript
import { ErrAsync, P } from "unthrown";

const retryOnce: ActivityMiddleware = (invocation, next) =>
  next().flatMapErrCases((matcher) =>
    matcher
      .with(P.instanceOf(ApplicationFailure), (error) =>
        error.type === "GATEWAY_TIMEOUT" ? next() : ErrAsync(error),
      )
      // The middleware error union is `ApplicationFailure | AnyContractError`,
      // and the matcher must cover all of it — pass declared errors through.
      .with(P._, (error) => ErrAsync(error)),
  );
```

::: tip Usually let Temporal retry
Temporal's own retry policy is durable — it survives a worker crash, where an
in-process retry does not. Retry in middleware only for something Temporal
cannot express, and prefer
[`activityOptions.retry`](/how-to/tune-activity-options) otherwise.
:::

## Time an activity

```typescript
const timing: ActivityMiddleware = ({ activityName }, next) => {
  const started = Date.now();
  return next().tap(() => {
    metrics.histogram("activity.duration", Date.now() - started, { activityName });
  });
};
```

`Date.now()` is fine here — middleware runs in the activity worker, not the
deterministic workflow sandbox.

## Next

- [Implement activities](/how-to/implement-activities)
- [Worker surface](/reference/worker-surface)
