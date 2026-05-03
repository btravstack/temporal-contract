# @temporal-contract/boxed

Custom `Future` and `Result` implementation for Temporal workflows, providing type-safe error handling and async operations compatible with Temporal's deterministic execution model.

## Why This Package?

The `@swan-io/boxed` library doesn't work properly with Temporal workflows due to Temporal's deterministic execution requirements. This package provides a Temporal-compatible implementation of the Result/Future patterns covering the same core API surface.

The two libraries are intentionally not 1:1 drop-ins — a few methods are absent here for determinism, soundness, or "not yet ported" reasons. See [@temporal-contract/boxed vs swan](https://btravers.github.io/temporal-contract/guide/boxed-vs-swan) for the full surface comparison and migration guide.

## Installation

```bash
pnpm add @temporal-contract/boxed
```

## Basic Usage

### Result Pattern

The `Result` type provides explicit error handling without exceptions:

```typescript
import { Result } from "@temporal-contract/boxed";

// Create results
const success = Result.Ok(42);
const failure = Result.Error("Something went wrong");

// Pattern matching
const value = success.match({
  Ok: (value) => value * 2,
  Error: (error) => 0,
});

// Transformations
const doubled = success.map((x) => x * 2);
const recovered = failure.mapError((e) => `Error: ${e}`);
```

### Future Pattern

The `Future` type wraps Promises with Result-based error handling:

```typescript
import { Future, Result } from "@temporal-contract/boxed";

// Create futures
const future = Future.value(42);
const fromPromise = Future.fromPromise(fetch("/api/data"));

// Transform values
const doubled = future.map((x) => x * 2);
const chained = future.flatMap((x) => Future.value(x * 2));

// Work with Results in Futures
const result = await Future.fromPromise(asyncOperation());
result.match({
  Ok: (value) => console.log("Success:", value),
  Error: (error) => console.error("Failed:", error),
});
```

## Usage in Temporal Workflows

### Activities

Activities return `Future<Result<T, ActivityError>>` for explicit error handling:

```typescript
import { Future, Result } from "@swan-io/boxed";
import { declareActivitiesHandler, ActivityError } from "@temporal-contract/worker/activity";

export const activities = declareActivitiesHandler({
  contract,
  activities: {
    processOrder: {
      processPayment: (args) => {
        return Future.fromPromise(paymentService.charge(args))
          .mapError(
            (error) =>
              new ActivityError(
                "PAYMENT_FAILED",
                error instanceof Error ? error.message : String(error),
                error,
              ),
          )
          .mapOk((result) => ({ transactionId: result.id }));
      },
    },
  },
});
```

### Workflows

```typescript
import { declareWorkflow } from "@temporal-contract/worker/workflow";

export const processOrder = declareWorkflow({
  workflowName: "processOrder",
  contract,
  activityOptions: { startToCloseTimeout: "1 minute" },
  implementation: async ({ activities }, input) => {
    // Activities return plain values (Result is unwrapped by framework)
    const payment = await activities.processPayment(input);

    // Workflow returns plain object (serializable for Temporal)
    return { success: true, transactionId: payment.transactionId };
  },
});
```

## Interoperability with @swan-io/boxed

This package provides bi-directional interoperability with `@swan-io/boxed` for smooth migration and compatibility.

### Default Compatibility (Recommended)

Our `Result` and `Future` types implement the same interface as `@swan-io/boxed`, making them compatible by default:

```typescript
import { Result, Future } from "@temporal-contract/boxed";

// Your types are already compatible with @swan-io/boxed consumers
const result = Result.Ok(42);
const future = Future.value(42);

// These work with any library expecting @swan-io/boxed types
function processSwanResult(r: SwanResult<number, string>) {
  return r.match({
    Ok: (v) => v * 2,
    Error: () => 0,
  });
}

processSwanResult(result); // ✅ Works directly
```

### Explicit Converters

For cases where you need explicit conversion, use the interop module:

```typescript
import { Result, Future } from "@temporal-contract/boxed";
import {
  fromSwanResult,
  toSwanResult,
  fromSwanFuture,
  toSwanFuture,
  fromSwanFutureResult,
  toSwanFutureResult,
} from "@temporal-contract/boxed/interop";

// Convert from @swan-io/boxed to @temporal-contract/boxed
const swanResult = externalLibrary.getSomething();
const temporalResult = fromSwanResult(swanResult);

// Convert from @temporal-contract/boxed to @swan-io/boxed
const temporalResult = Result.Ok(42);
const swanCompatible = toSwanResult(temporalResult);
externalLibrary.processSomething(swanCompatible);
```

### Interop API Reference

**Result Converters:**

- `fromSwanResult<T, E>(swanResult)` - Convert @swan-io/boxed Result to @temporal-contract/boxed Result
- `toSwanResult<T, E>(temporalResult)` - Convert @temporal-contract/boxed Result to @swan-io/boxed compatible Result

**Future Converters:**

- `fromSwanFuture<T>(swanFuture)` - Convert @swan-io/boxed Future to @temporal-contract/boxed Future
- `toSwanFuture<T>(temporalFuture)` - Convert @temporal-contract/boxed Future to @swan-io/boxed compatible Future

**Future<Result> Converters:**

- `fromSwanFutureResult<T, E>(swanFutureResult)` - Convert @swan-io/boxed Future<Result> to @temporal-contract/boxed Future<Result>
- `toSwanFutureResult<T, E>(temporalFutureResult)` - Convert @temporal-contract/boxed Future<Result> to @swan-io/boxed compatible Future<Result>

> **Note:** `@swan-io/boxed` is an optional peer dependency and only needed if you're explicitly converting between implementations.

## API Reference

### Result\<T, E>

- `Result.Ok<T>(value: T)` - Create a successful result
- `Result.Error<E>(error: E)` - Create an error result
- `isOk()` - Check if result is Ok
- `isError()` - Check if result is Error
- `match<R>(pattern)` - Pattern match on result
- `map<U>(fn)` - Transform Ok value
- `mapError<F>(fn)` - Transform Error value
- `flatMap<U>(fn)` - Chain results
- `flatMapOk<U>(fn)` - Alias for flatMap
- `getOr(defaultValue)` - Get value or default
- `Result.fromExecution(fn)` - Create result from synchronous function that may throw
- `Result.fromAsyncExecution(fn)` - Create result from async function that may throw
- `Result.all(results)` - Combine array of results into result of array

### Future\<T>

- `Future.value<T>(value)` - Create resolved future
- `Future.fromPromise<T>(promise)` - Create future from promise (returns `Future<Result<T, unknown>>`)
- `Future.make<T>(executor)` - Create future from executor function
- `Future.reject<T>(error)` - Create rejected future
- `Future.fromAsync<T>(fn)` - Create future from async function
- `Future.all(futures)` - Combine multiple futures
- `Future.race(futures)` - Race multiple futures
- `map<U>(fn)` - Transform future value
- `flatMap<U>(fn)` - Chain futures
- `mapOk<U>(fn)` - Transform Ok value in Future<Result>
- `mapError<F>(fn)` - Transform Error value in Future<Result>
- `flatMapOk<U>(fn)` - FlatMap over Ok value in Future<Result>
- `tap(fn)` - Execute side effect
- `tapOk(fn)` - Execute side effect on Ok
- `tapError(fn)` - Execute side effect on Error
- `toPromise()` - Convert to Promise

## TypeScript Support

This package is written in TypeScript and provides full type safety:

```typescript
// Type inference works automatically
const result = Result.Ok(42); // Result<number, never>
const error = Result.Error("failed"); // Result<never, string>

// Generic types can be specified explicitly
const typed: Result<number, string> = Result.Ok(42);
```

## Testing

```bash
cd packages/boxed
pnpm test
```

All tests verify:

- Result operations and transformations
- Future operations and async behavior
- Interoperability with @swan-io/boxed
- Type safety and compatibility

## Documentation

📖 **[Read the full documentation →](https://btravers.github.io/temporal-contract)**

- [API Reference](https://btravers.github.io/temporal-contract/api/boxed)
- [Result Pattern Guide](https://btravers.github.io/temporal-contract/guide/result-pattern)
- [Examples](https://btravers.github.io/temporal-contract/examples/)

## License

MIT
