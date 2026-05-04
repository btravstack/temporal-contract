/**
 * Coverage for the shared `_internal_makeResultAsync` helper.
 *
 * The helper closes the gap that bare `new ResultAsync(promise)` does not
 * catch: a synchronous throw or a rejected promise from `work()` would
 * otherwise surface as an unhandled rejection rather than `err(...)` on
 * neverthrow's typed error channel. Both consuming packages
 * (`@temporal-contract/client` and `@temporal-contract/worker`) rely on
 * this — see `client/src/internal.ts` and `worker/src/internal.ts`.
 */
import { describe, expect, it } from "vitest";
import { ok, err } from "neverthrow";
import { _internal_makeResultAsync } from "./result-async.js";

class TestError extends Error {
  constructor(public readonly tag: string) {
    super(`TestError(${tag})`);
    this.name = "TestError";
  }
}

describe("_internal_makeResultAsync", () => {
  it("returns ok(...) when the work function resolves with ok(...)", async () => {
    const result = await _internal_makeResultAsync<number, TestError>(
      async () => ok(42),
      (e) => new TestError(`unexpected:${String(e)}`),
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(42);
    }
  });

  it("returns err(...) unchanged when the work function resolves with err(...)", async () => {
    const domainError = new TestError("domain");
    const result = await _internal_makeResultAsync<number, TestError>(
      async () => err(domainError),
      (e) => new TestError(`unexpected:${String(e)}`),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      // Identity preserved — the domain `err(...)` flows through untouched.
      expect(result.error).toBe(domainError);
    }
  });

  it("routes a rejected promise through mapRejection as err(...)", async () => {
    // Without the helper, `new ResultAsync(work())` rejects rather than
    // resolving to err(...) — this is the unhandled-rejection gap the
    // helper closes.
    const thrown = new Error("kaboom");
    const result = await _internal_makeResultAsync<number, TestError>(
      async () => {
        // Force at least one microtask before throwing so this exercises
        // the rejection branch of the catch (vs. the synchronous-throw
        // branch covered by the next test).
        await Promise.resolve();
        throw thrown;
      },
      (e) => new TestError(`mapped:${(e as Error).message}`),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(TestError);
      expect(result.error.tag).toBe("mapped:kaboom");
    }
  });

  it("routes a synchronous throw before the first await through mapRejection", async () => {
    // A non-async wrapper that throws *before* returning a promise. This
    // exercises the outer try/catch in the helper — without it, calling
    // `work()` would throw synchronously and the consumer would see the
    // exception bubble out of the helper rather than land on err(...).
    const thrown = new Error("sync-blow-up");
    const result = await _internal_makeResultAsync<number, TestError>(
      () => {
        throw thrown;
      },
      (e) => new TestError(`mapped:${(e as Error).message}`),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(TestError);
      expect(result.error.tag).toBe("mapped:sync-blow-up");
    }
  });

  it("forwards the thrown value to mapRejection so callers can introspect it", async () => {
    const thrown = { kind: "non-error-throwable" };
    let captured: unknown;
    const result = await _internal_makeResultAsync<number, TestError>(
      async () => {
        // Throwing a non-Error is legal in JS — the helper must not assume
        // the value has `.message` and the mapper sees it untouched.
        await Promise.resolve();
        throw thrown;
      },
      (e) => {
        captured = e;
        return new TestError("mapped");
      },
    );
    expect(captured).toBe(thrown);
    expect(result.isErr()).toBe(true);
  });
});
