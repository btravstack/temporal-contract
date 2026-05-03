---
"@temporal-contract/worker": minor
"@temporal-contract/contract": minor
"@temporal-contract/client": minor
"@temporal-contract/boxed": minor
"@temporal-contract/testing": minor
---

`ActivityError` now carries Temporal retry-policy metadata, and `ApplicationFailure` is accepted as a `Result.Error` variant.

Closes #121.

## What changed

The third positional argument of `ActivityError` is now an options object:

```ts
type ActivityErrorOptions = {
  cause?: unknown;
  nonRetryable?: boolean; // NEW — skips retries when true
  details?: unknown[]; // NEW — structured payload on the failure
  nextRetryDelay?: Duration; // NEW — overrides retry policy delay
};
```

At throw-time, the worker translates an `ActivityError` into a Temporal `ApplicationFailure` so the `nonRetryable`, `type` (= `code`), `details`, `nextRetryDelay`, and `cause` fields are honored at the SDK boundary. Previously, the wrapper threw the raw `ActivityError`, which Temporal saw as a regular error — `nonRetryable: true` had no effect.

For users who already build `ApplicationFailure` instances directly (for cross-SDK consistency or other reasons), the `Result.Error` variant of an activity now accepts `ActivityError | ApplicationFailure`. `ApplicationFailure` instances are forwarded unchanged.

## Migration

The third arg of `ActivityError` is now an options object. If you were passing the cause as the third positional, wrap it:

```diff
- new ActivityError("PAYMENT_FAILED", "Payment failed", error)
+ new ActivityError("PAYMENT_FAILED", "Payment failed", { cause: error })
```

To mark a failure as non-retryable (the issue's headline ask):

```ts
return Future.value(
  Result.Error(new ActivityError("PAYMENT_DECLINED", "Card was declined", { nonRetryable: true })),
);
```

Or use Temporal's standard `ApplicationFailure` directly:

```ts
import { ApplicationFailure } from "@temporalio/common";

return Future.value(
  Result.Error(ApplicationFailure.nonRetryable("Card was declined", "PAYMENT_DECLINED")),
);
```

## New peer dependency

`@temporal-contract/worker` now lists `@temporalio/common` as a peer dependency (alongside the existing `@temporalio/worker` and `@temporalio/workflow` peers). Most consumers already have it transitively.
