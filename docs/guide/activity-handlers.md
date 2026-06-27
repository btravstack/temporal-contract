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
import { orderContract } from "./contract";

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
import { ApplicationFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";
import { orderContract } from "../contracts/order.contract";

type Handlers = ActivitiesHandler<typeof orderContract>;

export const sendEmail: Handlers["sendEmail"] = ({ to, body }) =>
  fromPromise(emailService.send({ to, body }), (error) =>
    ApplicationFailure.create({
      type: "EMAIL_FAILED",
      message: error instanceof Error ? error.message : "Failed to send email",
      ...(error instanceof Error ? { cause: error } : {}),
    }),
  ).map(() => ({ sent: true }));
```

```typescript
// activities/payment.ts
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";
import { ApplicationFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";
import { orderContract } from "../contracts/order.contract";

type Handlers = ActivitiesHandler<typeof orderContract>;

export const processPayment: Handlers["processPayment"] = ({ amount }) =>
  fromPromise(paymentGateway.charge(amount), (error) =>
    ApplicationFailure.create({
      type: "PAYMENT_FAILED",
      message: error instanceof Error ? error.message : "Payment failed",
      ...(error instanceof Error ? { cause: error } : {}),
    }),
  ).map((txId) => ({ transactionId: txId }));
```

```typescript
// activities/index.ts
import { declareActivitiesHandler } from "@temporal-contract/worker/activity";
import { orderContract } from "../contracts/order.contract";
import { sendEmail } from "./email";
import { processPayment } from "./payment";

export const activities = declareActivitiesHandler({
  contract: orderContract,
  activities: {
    sendEmail,
    processPayment,
  },
});
```

### 2. Dependency Injection

Create factory functions with typed activities:

```typescript
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";
import { ApplicationFailure } from "@temporal-contract/worker/activity";
import { fromPromise } from "unthrown";

type Handlers = ActivitiesHandler<typeof orderContract>;

export const createEmailActivity =
  (emailService: EmailService): Handlers["sendEmail"] =>
  ({ to, body }) =>
    fromPromise(emailService.send({ to, body }), (error) =>
      ApplicationFailure.create({
        type: "EMAIL_FAILED",
        message: error instanceof Error ? error.message : "Failed",
        ...(error instanceof Error ? { cause: error } : {}),
      }),
    ).map(() => ({ sent: true }));

export const createPaymentActivity =
  (paymentGateway: PaymentGateway): Handlers["processPayment"] =>
  ({ amount }) =>
    fromPromise(paymentGateway.charge(amount), (error) =>
      ApplicationFailure.create({
        type: "PAYMENT_FAILED",
        message: error instanceof Error ? error.message : "Failed",
        ...(error instanceof Error ? { cause: error } : {}),
      }),
    ).map((txId) => ({ transactionId: txId }));
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

## Advanced Patterns

### Middleware Pattern

Wrap activities with middleware:

```typescript
import type { ActivitiesHandler } from "@temporal-contract/worker/activity";

type Handlers = ActivitiesHandler<typeof orderContract>;

// Create logging middleware
function withLogging<T extends (...args: any[]) => any>(name: string, fn: T): T {
  return (async (...args: any[]) => {
    console.log(`[${name}] Starting`, args);
    try {
      const result = await fn(...args);
      console.log(`[${name}] Success`, result);
      return result;
    } catch (error) {
      console.error(`[${name}] Error`, error);
      throw error;
    }
  }) as T;
}

// Apply to activities
const sendEmail: Handlers["sendEmail"] = withLogging("sendEmail", async ({ to, body }) => {
  await emailService.send({ to, body });
  return { sent: true };
});
```

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
    fromPromise(services.email.send({ to, body }), (error) =>
      ApplicationFailure.create({
        type: "EMAIL_FAILED",
        message: error instanceof Error ? error.message : "Failed",
        ...(error instanceof Error ? { cause: error } : {}),
      }),
    ).map(() => ({ sent: true }));

  return { sendEmail };
};
```

## See Also

- [Worker Implementation](/guide/worker-implementation)
- [Entry Points Architecture](/guide/entry-points)
- [Examples](/examples/)
