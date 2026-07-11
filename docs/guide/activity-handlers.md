# Activity Handler Types

Type utilities for cleaner activity implementations.

## Overview

temporal-contract provides type utilities to extract activity handler types from your contracts, making activity implementations more maintainable and reusable.

## Basic Usage

Instead of defining activity implementations inline, you can extract types for reuse:

```typescript
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";
import { declareActivitiesHandler, ApplicationFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";
import { orderContract } from "./contract.js";

// Extract all activity handler types from contract
type OrderActivitiesHandler = ActivitiesHandler<typeof orderContract>;

// Implement activities with explicit types using AsyncResult
const sendEmail: OrderActivitiesHandler["sendEmail"] = ({ to, body }) =>
  fromPromise(emailService.send({ to, body }), (error) =>
    ApplicationFailure.create({
      type: "EMAIL_FAILED",
      message: error instanceof Error ? error.message : "Failed to send email",
      ...(error instanceof Error ? { cause: error } : {}),
    }),
  ).map(() => ({ sent: true }));

const processPayment: OrderActivitiesHandler["processPayment"] = ({ amount }) =>
  fromPromise(paymentGateway.charge(amount), (error) =>
    ApplicationFailure.create({
      type: "PAYMENT_FAILED",
      message: error instanceof Error ? error.message : "Payment failed",
      ...(error instanceof Error ? { cause: error } : {}),
    }),
  ).map((txId) => ({ transactionId: txId }));

// Use in handler
export const activities = declareActivitiesHandler({
  contract: orderContract,
  activities: {
    sendEmail,
    processPayment,
  },
});
```

::: tip Less boilerplate with `qualify`
The hand-written `ApplicationFailure.create` wrapping above is what the
`qualify` helper does for you — an `Error` rejection keeps its message and is
preserved as `cause`:

```typescript
import { qualify } from "@temporal-contract/worker/activity";

const sendEmail: OrderActivitiesHandler["sendEmail"] = ({ to, body }) =>
  fromPromise(emailService.send({ to, body }), qualify("EMAIL_FAILED")).map(() => ({
    sent: true,
  }));
```

Pass `{ nonRetryable: true }` for permanent failures, `{ message: "..." }` as
a fallback for non-`Error` rejections, and `{ details: [...] }` for a
structured payload. The examples below use it throughout.
:::

## Type Utilities

### ActivitiesHandler

Extract all activity handler types from a contract:

```typescript
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";

type MyActivities = ActivitiesHandler<typeof myContract>;
// {
//   sendEmail: (input: { to: string, body: string }) => AsyncResult<{ sent: boolean }, ApplicationFailure>;
//   processPayment: (input: { amount: number }) => AsyncResult<{ transactionId: string }, ApplicationFailure>;
// }
```

### Individual Activity Types

Extract specific activity types:

```typescript
type SendEmailHandler = ActivitiesHandler<typeof contract>["sendEmail"];
type ProcessPaymentHandler = ActivitiesHandler<typeof contract>["processPayment"];

const sendEmail: SendEmailHandler = ({ to, body }) => {
  // Implementation — must return AsyncResult<T, ApplicationFailure>
  return Ok({ sent: true }).toAsync();
};
```

## Benefits

### 1. Separation of Concerns

Implement activities in separate files:

```typescript
// activities/email.ts
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";
import { qualify } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";
import { orderContract } from "../contracts/order.contract.js";

type Handlers = ActivitiesHandler<typeof orderContract>;

export const sendEmail: Handlers["sendEmail"] = ({ to, body }) =>
  fromPromise(emailService.send({ to, body }), qualify("EMAIL_FAILED")).map(() => ({
    sent: true,
  }));
```

```typescript
// activities/payment.ts
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";
import { qualify } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";
import { orderContract } from "../contracts/order.contract.js";

type Handlers = ActivitiesHandler<typeof orderContract>;

export const processPayment: Handlers["processPayment"] = ({ amount }) =>
  fromPromise(paymentGateway.charge(amount), qualify("PAYMENT_FAILED")).map((txId) => ({
    transactionId: txId,
  }));
```

```typescript
// activities/index.ts
import { declareActivitiesHandler } from "@temporal-contract/worker/activity";
import { orderContract } from "../contracts/order.contract.js";
import { sendEmail } from "./email.js";
import { processPayment } from "./payment.js";

export const activities = declareActivitiesHandler({
  contract: orderContract,
  activities: {
    sendEmail,
    processPayment,
  },
});
```

### 2. Dependency Injection

`declareActivitiesHandler` accepts a `createContext` factory whose result is
handed to every implementation as `helpers.context` — dependencies become a
typed, first-class part of the handler instead of module-scope closures:

```typescript
export const activities = declareActivitiesHandler({
  contract: orderContract,
  createContext: () => ({
    emailService: new EmailService(),
    paymentGateway: new PaymentGateway(),
  }),
  activities: {
    sendEmail: ({ to, body }, { context }) =>
      fromPromise(context.emailService.send({ to, body }), (error) =>
        ApplicationFailure.create({
          type: "EMAIL_FAILED",
          message: error instanceof Error ? error.message : "Failed",
          ...(error instanceof Error ? { cause: error } : {}),
        }),
      ).map(() => ({ sent: true })),
  },
});
```

`createContext` runs once per activity execution and receives
`{ activityName, workflowName }`, so it can produce request-scoped values;
close over singletons (connection pools, service clients) for per-worker
dependencies.

#### Scoped contexts with demesne (recommended)

For contexts that own _resources_ (a per-invocation logger with correlation
ids, a transaction that must commit/rollback), the recommended
`createContext` engine is [demesne](https://github.com/btravstack/demesne)'s
`Layer.forkScope` — the org's request-scoped DI layer. Build the app graph
once at worker startup with `Layer.scoped` (connections via
`acquireRelease`, graceful shutdown via `onStop`), then fork a child scope
per invocation: request-scoped services are built fresh in the fork and
released LIFO after the handler, while the app singletons stay untouched.
demesne shares unthrown's `Result` channels, so the fork's error union
composes directly into the activity's `AsyncResult`:

```typescript
import { Layer } from "demesne";
import { AppLive, InvocationScopeLive, RequestLogger } from "./layers.js";

// App lifetime: singletons built once, released on shutdown.
await Layer.scoped(AppLive, async (appCtx) => {
  const activities = declareActivitiesHandler({
    contract: orderContract,
    activities: {
      chargePayment: (args, _helpers) =>
        // Per-invocation fork: request-scoped services (correlation-id
        // logger, transaction) live in the fork, released after the handler.
        Layer.forkScope(appCtx, InvocationScopeLive, (ctx) => {
          ctx.get(RequestLogger).info("charging payment");
          return chargeWith(ctx, args);
        }),
    },
  });
  // ... create and run the worker with `activities`
});
```

demesne stays an **optional peer** — documented as the recommended context
provider, never required.

Factory functions remain a fine alternative when you prefer wiring each
activity explicitly:

```typescript
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";
import { qualify } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

type Handlers = ActivitiesHandler<typeof orderContract>;

export const createEmailActivity =
  (emailService: EmailService): Handlers["sendEmail"] =>
  ({ to, body }) =>
    fromPromise(emailService.send({ to, body }), qualify("EMAIL_FAILED")).map(() => ({
      sent: true,
    }));

export const createPaymentActivity =
  (paymentGateway: PaymentGateway): Handlers["processPayment"] =>
  ({ amount }) =>
    fromPromise(paymentGateway.charge(amount), qualify("PAYMENT_FAILED")).map((txId) => ({
      transactionId: txId,
    }));
```

Usage:

```typescript
const emailService = new EmailService();
const paymentGateway = new PaymentGateway();

export const activities = declareActivitiesHandler({
  contract: orderContract,
  activities: {
    sendEmail: createEmailActivity(emailService),
    processPayment: createPaymentActivity(paymentGateway),
  },
});
```

### 3. Testability

Mock activities with correct types:

```typescript
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";
import { Ok } from "unthrown";

type Handlers = ActivitiesHandler<typeof orderContract>;

// Create mock activities for testing
const mockActivities: Handlers = {
  sendEmail: ({ to, body }) => Ok({ sent: true }).toAsync(),
  processPayment: ({ amount }) => Ok({ transactionId: "TEST-TXN" }).toAsync(),
};

// Use in tests
describe("processOrder", () => {
  it("should process payment", async () => {
    const context = createMockContext(mockActivities);
    const result = await processOrder.implementation(context, {
      orderId: "ORD-123",
    });
    expect(result.success).toBe(true);
  });
});
```

## Typed Contract Errors

When an activity declares an `errors` map on the contract (see
[Defining Contracts](/guide/defining-contracts)), the implementation receives
typed constructors for them via the second (`helpers`) argument. Returning
one on the `Err` channel serializes it as an `ApplicationFailure` whose
`type` is the error name, whose `details[0]` is the schema-validated payload,
and whose `nonRetryable` flag comes from the contract declaration:

```typescript
export const activities = declareActivitiesHandler({
  contract: orderContract,
  activities: {
    processPayment: ({ amount }, { errors }) =>
      fromPromise(paymentGateway.charge(amount), (error) =>
        ApplicationFailure.create({
          type: "PAYMENT_GATEWAY_FAILED", // technical failure → retried
          message: "Gateway call failed",
          ...(error instanceof Error ? { cause: error } : {}),
        }),
      ).flatMap((outcome) =>
        outcome.approved
          ? Ok({ transactionId: outcome.id })
          : // Declared domain error → typed on the workflow side, and
            // non-retryable if the contract says so.
            Err(errors.PaymentDeclined({ reason: outcome.reason })),
      ),
  },
});
```

On the workflow side, calls to an errors-declaring activity return an
`AsyncResult` whose error channel carries the rehydrated typed union —
see [Worker Implementation](/guide/worker-implementation) for the consuming
side.

## Advanced Patterns

### Middleware

`declareActivitiesHandler` accepts a contract-aware `middleware` — a single
middleware, or a typed chain built with `composeActivityMiddleware`
(outermost-first). Middleware runs inside the validation boundary — it sees
the schema-validated input, the activity's identity, and the accumulated
context — and operates on the unthrown `AsyncResult`, so modeled failures
appear on the `err` channel instead of as thrown exceptions:

```typescript
import {
  composeActivityMiddleware,
  defineActivityMiddleware,
  type ActivityMiddleware,
} from "@temporal-contract/worker/activity";

const logging: ActivityMiddleware = ({ activityName, workflowName }, next) =>
  next().tapErr((error) => {
    logger.warn({ activityName, workflowName, error }, "activity failed");
  });

const timing: ActivityMiddleware = async ({ activityName }, next) => {
  const started = Date.now();
  const result = await next();
  metrics.timing(`activity.${activityName}`, Date.now() - started);
  return result.toAsync();
};

export const activities = declareActivitiesHandler({
  contract: orderContract,
  // logging wraps timing wraps the implementation
  middleware: composeActivityMiddleware(logging, timing),
  activities: {
    /* ... */
  },
});
```

A middleware can short-circuit by returning its own result without calling
`next` (the output is still validated against the contract), and can
substitute the input seen by the next stage with `next({ input })` — a
substituted input is re-validated against the contract's schema.

### Accumulating context (guard-and-narrow)

Middleware can _extend_ the typed context flowing downstream with
`next({ context })`. Each middleware declares what it receives (`TContextIn`,
the `createContext` seed for the outermost one) and what it passes on
(`TContextOut extends TContextIn`); `composeActivityMiddleware` accumulates
the types across the chain, and implementations receive the final context as
`helpers.context`:

```typescript
import { defineActivityMiddleware, type EmptyContext } from "@temporal-contract/worker/activity";

const auth = defineActivityMiddleware<EmptyContext, { tenantId: string }>((invocation, next) => {
  const tenantId = readTenant(invocation.input);
  if (!tenantId) {
    return Err(
      ApplicationFailure.create({ type: "Unauthenticated", nonRetryable: true }),
    ).toAsync();
  }
  return next({ context: { tenantId } });
});

const tracing = defineActivityMiddleware<
  { tenantId: string },
  { tenantId: string; traceId: string }
>((invocation, next) => next({ context: { ...invocation.context, traceId: newTraceId() } }));

export const activities = declareActivitiesHandler({
  contract: orderContract,
  middleware: composeActivityMiddleware(auth, tracing),
  activities: {
    chargePayment: (args, { context }) => {
      // context: { tenantId: string; traceId: string }
      /* ... */
    },
  },
});
```

A middleware that only _reads_ the context stays valid unchanged — read-only
semantics need no type parameters.

### Retry Logic

Add retry logic to activities:

```typescript
function withRetry<T extends (...args: any[]) => Promise<any>>(fn: T, maxRetries = 3): T {
  return (async (...args: any[]) => {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn(...args);
      } catch (error) {
        lastError = error;
        if (i < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
        }
      }
    }
    throw lastError;
  }) as T;
}

const processPayment: Handlers["processPayment"] = withRetry(async ({ amount }) => {
  const txId = await paymentGateway.charge(amount);
  return { transactionId: txId };
}, 3);
```

### Caching Pattern

Add caching to expensive activities:

```typescript
const cache = new Map<string, any>();

function withCache<T extends (input: any) => Promise<any>>(
  fn: T,
  keyFn: (input: any) => string,
): T {
  return (async (input: any) => {
    const key = keyFn(input);
    if (cache.has(key)) {
      return cache.get(key);
    }
    const result = await fn(input);
    cache.set(key, result);
    return result;
  }) as T;
}

const validateInventory: Handlers["validateInventory"] = withCache(
  async ({ orderId }) => {
    const available = await inventoryDB.check(orderId);
    return { available };
  },
  ({ orderId }) => orderId,
);
```

## Best Practices

### 1. Use Type Utilities

Always extract types for better maintainability:

```typescript
// ✅ Good
type Handlers = ActivitiesHandler<typeof contract>;
const sendEmail: Handlers["sendEmail"] = ({ to, body }) => Ok({ sent: true }).toAsync();

// ❌ Avoid inline typing
const sendEmail = ({ to, body }: { to: string; body: string }) => Ok({ sent: true }).toAsync();
```

### 2. Organize by Domain

Group related activities:

```typescript
// activities/payment/index.ts
export const processPayment: Handlers['processPayment'] = /* ... */;
export const refundPayment: Handlers['refundPayment'] = /* ... */;

// activities/email/index.ts
export const sendEmail: Handlers['sendEmail'] = /* ... */;
export const sendBulkEmail: Handlers['sendBulkEmail'] = /* ... */;
```

### 3. Use Dependency Injection

Make activities testable and configurable:

```typescript
export const createActivities = (services: Services) => {
  const sendEmail: Handlers["sendEmail"] = ({ to, body }) =>
    fromPromise(services.email.send({ to, body }), qualify("EMAIL_FAILED")).map(() => ({
      sent: true,
    }));

  return { sendEmail };
};
```

## See Also

- [Worker Implementation](/guide/worker-implementation)
- [Entry Points Architecture](/guide/entry-points)
- [Examples](/examples/)
