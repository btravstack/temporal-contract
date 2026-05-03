/**
 * Result type representing either a successful value (Ok) or an error (Err)
 * This is a custom implementation compatible with Temporal workflows
 *
 * Note: The error variant class is named `Err` internally to avoid shadowing
 * the global `Error` constructor. The public API still uses `Result.Error()`
 * as a factory and `isError()` as a type guard for backward compatibility.
 */

export type Result<T, E> = Ok<T, E> | Err<T, E>;

/**
 * Ok variant representing a successful result
 */
export class Ok<T, E> {
  readonly tag = "Ok" as const;
  readonly value: T;

  constructor(value: T) {
    this.value = value;
  }

  isOk(): this is Ok<T, E> {
    return true;
  }

  isError(): this is Err<T, E> {
    return false;
  }

  map<U>(fn: (value: T) => U): Result<U, E> {
    return new Ok(fn(this.value));
  }

  mapError<F>(_fn: (error: E) => F): Result<T, F> {
    return new Ok(this.value);
  }

  flatMap<U>(fn: (value: T) => Result<U, E>): Result<U, E> {
    return fn(this.value);
  }

  flatMapOk<U>(fn: (value: T) => Result<U, E>): Result<U, E> {
    return fn(this.value);
  }

  flatMapError<F>(_fn: (error: E) => Result<T, F>): Result<T, F> {
    return new Ok(this.value);
  }

  /**
   * Run a side effect with the Ok value, then return this Result unchanged.
   * No-op on Err. Useful for logging / metrics in a chain without breaking it.
   */
  tap(fn: (value: T) => void): Result<T, E> {
    fn(this.value);
    return this;
  }

  /**
   * Run a side effect with the Err value, then return this Result unchanged.
   * No-op on Ok.
   */
  tapError(_fn: (error: E) => void): Result<T, E> {
    return this;
  }

  getOr(_defaultValue: T): T {
    return this.value;
  }

  match<R>(pattern: { Ok: (value: T) => R; Error: (error: E) => R }): R {
    return pattern.Ok(this.value);
  }
}

/**
 * Err variant representing a failed result.
 *
 * Named `Err` to avoid shadowing the global `Error` constructor.
 * Use `Result.Error()` factory or `isError()` type guard in consuming code.
 */
export class Err<T, E> {
  readonly tag = "Error" as const;
  readonly error: E;

  constructor(error: E) {
    this.error = error;
  }

  isOk(): this is Ok<T, E> {
    return false;
  }

  isError(): this is Err<T, E> {
    return true;
  }

  map<U>(_fn: (value: T) => U): Result<U, E> {
    return new Err(this.error);
  }

  mapError<F>(fn: (error: E) => F): Result<T, F> {
    return new Err(fn(this.error));
  }

  flatMap<U>(_fn: (value: T) => Result<U, E>): Result<U, E> {
    return new Err(this.error);
  }

  flatMapOk<U>(_fn: (value: T) => Result<U, E>): Result<U, E> {
    return new Err(this.error);
  }

  flatMapError<F>(fn: (error: E) => Result<T, F>): Result<T, F> {
    return fn(this.error);
  }

  /**
   * Run a side effect with the Ok value, then return this Result unchanged.
   * No-op on Err.
   */
  tap(_fn: (value: T) => void): Result<T, E> {
    return this;
  }

  /**
   * Run a side effect with the Err value, then return this Result unchanged.
   * No-op on Ok. Useful for logging / metrics in a chain without breaking it.
   */
  tapError(fn: (error: E) => void): Result<T, E> {
    fn(this.error);
    return this;
  }

  getOr(defaultValue: T): T {
    return defaultValue;
  }

  match<R>(pattern: { Ok: (value: T) => R; Error: (error: E) => R }): R {
    return pattern.Error(this.error);
  }
}

/**
 * Result namespace with factory methods
 */
export const Result = {
  Ok: <T, E = never>(value: T): Result<T, E> => new Ok<T, E>(value),
  Error: <T = never, E = unknown>(error: E): Result<T, E> => new Err<T, E>(error),

  isOk: <T, E>(result: Result<T, E>): result is Ok<T, E> => result.isOk(),
  isError: <T, E>(result: Result<T, E>): result is Err<T, E> => result.isError(),

  /**
   * Run a synchronous function, capturing any thrown value as `Result.Error`.
   *
   * The error is typed as `unknown` because anything can be thrown in
   * JavaScript. Narrow it via `.mapError(...)` at the call site:
   *
   * @example
   * ```ts
   * const parsed = Result.fromExecution(() => JSON.parse(input))
   *   .mapError((e) => e instanceof SyntaxError ? e : new Error(String(e)));
   * ```
   */
  fromExecution: <T>(fn: () => T): Result<T, unknown> => {
    try {
      return new Ok<T, unknown>(fn());
    } catch (error) {
      return new Err<T, unknown>(error);
    }
  },

  /**
   * Run an async function, capturing any rejection as `Result.Error`.
   *
   * The error is typed as `unknown`; narrow it via `.mapError(...)` on the
   * resulting `Result`.
   */
  fromAsyncExecution: async <T>(fn: () => Promise<T>): Promise<Result<T, unknown>> => {
    try {
      return new Ok<T, unknown>(await fn());
    } catch (error) {
      return new Err<T, unknown>(error);
    }
  },

  all: <T, E>(results: Result<T, E>[]): Result<T[], E> => {
    const values: T[] = [];
    for (const result of results) {
      if (result.isError()) {
        return new Err(result.error);
      }
      values.push(result.value);
    }
    return new Ok(values);
  },

  /**
   * Combine a record of `Result`s into a single `Result` of a record.
   *
   * Iteration order matches `Object.entries`. Returns the first `Err`
   * encountered; otherwise returns `Ok` of a record with each value
   * unwrapped under its original key.
   *
   * @example
   * ```ts
   * const combined = Result.allFromDict({
   *   user: lookupUser(id),     // Result<User, NotFoundError>
   *   prefs: loadPrefs(id),     // Result<Prefs, NotFoundError>
   * });
   * // Result<{ user: User; prefs: Prefs }, NotFoundError>
   * ```
   */
  allFromDict: <TDict extends Record<string, Result<unknown, unknown>>>(
    dict: TDict,
  ): Result<
    { [K in keyof TDict]: TDict[K] extends Result<infer V, unknown> ? V : never },
    TDict[keyof TDict] extends Result<unknown, infer F> ? F : never
  > => {
    type OkRecord = {
      [K in keyof TDict]: TDict[K] extends Result<infer V, unknown> ? V : never;
    };
    type ErrUnion = TDict[keyof TDict] extends Result<unknown, infer F> ? F : never;
    const values: Record<string, unknown> = {};
    for (const [key, result] of Object.entries(dict)) {
      if (result.isError()) {
        return new Err<OkRecord, ErrUnion>(result.error as ErrUnion);
      }
      values[key] = result.value;
    }
    return new Ok<OkRecord, ErrUnion>(values as OkRecord);
  },
};
