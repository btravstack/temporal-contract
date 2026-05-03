import type { Result } from "./result.js";
import { Ok, Err } from "./result.js";

/**
 * Future type representing an asynchronous computation
 * This is a custom implementation compatible with Temporal workflows
 */
export class Future<T> implements Promise<T> {
  private readonly promise: Promise<T>;

  // Required for Promise implementation
  readonly [Symbol.toStringTag] = "Future";

  private constructor(promise: Promise<T>) {
    this.promise = promise;
  }

  /**
   * Create a Future from an executor function
   */
  static make<T>(executor: (resolve: (value: T) => void) => void): Future<T> {
    const promise = new Promise<T>((resolve) => {
      executor(resolve);
    });
    return new Future(promise);
  }

  /**
   * Create a Future from a value
   */
  static value<T>(value: T): Future<T> {
    return new Future(Promise.resolve(value));
  }

  /**
   * Create a Future from a Promise.
   *
   * Without `mapError`, rejections are surfaced as `Result.Error<unknown>` and
   * the caller is expected to narrow them. Pass `mapError` to lift the error
   * type at the boundary — useful when the consumer has a specific domain
   * error class:
   *
   * @example
   * ```ts
   * Future.fromPromise(handle.terminate(), (e) => new RuntimeClientError("terminate", e));
   * ```
   */
  static fromPromise<T>(promise: Promise<T>): Future<Result<T, unknown>>;
  static fromPromise<T, E>(
    promise: Promise<T>,
    mapError: (error: unknown) => E,
  ): Future<Result<T, E>>;
  static fromPromise<T, E>(
    promise: Promise<T>,
    mapError?: (error: unknown) => E,
  ): Future<Result<T, E | unknown>> {
    return new Future(
      promise
        .then((value) => new Ok<T, E | unknown>(value) as Result<T, E | unknown>)
        .catch((error) => {
          if (!mapError) {
            return new Err<T, unknown>(error) as Result<T, E | unknown>;
          }
          // If `mapError` itself throws, surface the mapper's exception as the
          // Result's error rather than letting the Future reject. The whole
          // point of `fromPromise` is to convert rejections into Results, so
          // a faulty mapper must not break that invariant.
          try {
            return new Err<T, E>(mapError(error)) as Result<T, E | unknown>;
          } catch (mapperError) {
            return new Err<T, unknown>(mapperError) as Result<T, E | unknown>;
          }
        }),
    );
  }

  /**
   * Create a rejected Future
   */
  static reject<T = never>(error: unknown): Future<T> {
    return new Future(Promise.reject(error));
  }

  /**
   * Combine multiple Futures into one
   */
  static all<T>(futures: Future<T>[]): Future<T[]> {
    return new Future(Promise.all(futures.map((f) => f.promise)));
  }

  /**
   * Race multiple Futures
   */
  static race<T>(futures: Future<T>[]): Future<T> {
    return new Future(Promise.race(futures.map((f) => f.promise)));
  }

  /**
   * Create a Future from an async function.
   *
   * Prefer this over `Future.make` when the executor is async, as it properly
   * propagates rejections instead of leaving the Future pending on unhandled errors.
   *
   * @example
   * ```ts
   * const future = Future.fromAsync(async () => {
   *   const data = await fetchSomething();
   *   return data;
   * });
   * ```
   */
  static fromAsync<T>(fn: () => Promise<T>): Future<T> {
    return new Future(fn());
  }

  /**
   * Map the result of the Future
   */
  map<U>(fn: (value: T) => U): Future<U> {
    return new Future(this.promise.then(fn));
  }

  /**
   * FlatMap the result of the Future
   */
  flatMap<U>(fn: (value: T) => Future<U>): Future<U> {
    return new Future(this.promise.then((value) => fn(value).promise));
  }

  /**
   * Map over a Result within a Future
   */
  mapOk<V, U, E>(this: Future<Result<V, E>>, fn: (value: V) => U): Future<Result<U, E>> {
    return this.map((result) => {
      if (result.isOk()) {
        return new Ok(fn(result.value));
      }
      return new Err(result.error);
    });
  }

  /**
   * Map over an error in a Result within a Future
   */
  mapError<V, E, F>(this: Future<Result<V, E>>, fn: (error: E) => F): Future<Result<V, F>> {
    return this.map((result) => {
      if (result.isError()) {
        return new Err(fn(result.error));
      }
      return new Ok(result.value);
    });
  }

  /**
   * FlatMap over a Result within a Future
   */
  flatMapOk<V, E, U>(
    this: Future<Result<V, E>>,
    fn: (value: V) => Future<Result<U, E>>,
  ): Future<Result<U, E>> {
    return new Future(
      this.promise.then((result) => {
        if (result.isOk()) {
          return fn(result.value).promise;
        }
        return Promise.resolve(new Err(result.error));
      }),
    );
  }

  /**
   * Tap into the Future value without changing it
   */
  tap(fn: (value: T) => void): Future<T> {
    return this.map((value) => {
      fn(value);
      return value;
    });
  }

  /**
   * Tap into Ok values in a Result
   */
  tapOk<V, E>(this: Future<Result<V, E>>, fn: (value: V) => void): Future<Result<V, E>> {
    return this.tap((result) => {
      if (result.isOk()) {
        fn(result.value);
      }
    });
  }

  /**
   * Tap into Error values in a Result
   */
  tapError<V, E>(this: Future<Result<V, E>>, fn: (error: E) => void): Future<Result<V, E>> {
    return this.tap((result) => {
      if (result.isError()) {
        fn(result.error);
      }
    });
  }

  /**
   * Convert to a Promise (for await)
   */
  toPromise(): Promise<T> {
    return this.promise;
  }

  // Promise interface implementation.
  //
  // Note: `then` / `catch` / `finally` return a raw `Promise`, **not** a
  // `Future`. They exist so a Future is `await`able (and to satisfy the
  // `Promise<T>` interface for interop). For chainable, type-preserving
  // transforms use `.map`, `.flatMap`, `.mapOk`, `.flatMapOk`, etc.
  // eslint-disable-next-line unicorn/no-thenable
  then<TResult1 = T, TResult2 = never>(
    onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onFulfilled, onRejected);
  }

  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T | TResult> {
    return this.promise.catch(onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<T> {
    return this.promise.finally(onFinally);
  }
}
