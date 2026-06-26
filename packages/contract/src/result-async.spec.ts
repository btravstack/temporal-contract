/**
 * Coverage for the shared `_internal_makeAsyncResult` helper.
 *
 * The helper routes a synchronous throw or a rejected promise from `work()`
 * through unthrown's `defect` channel — an *unanticipated* failure becomes a
 * defect (a bug, re-thrown at the edge) rather than an unhandled rejection,
 * while the work function's own domain `err(...)` flows through untouched.
 * Both consuming packages (`@temporal-contract/client` and
 * `@temporal-contract/worker`) rely on this — see `client/src/internal.ts`
 * and `worker/src/internal.ts`.
 */
import { describe, expect, it } from "vitest";
import { ok, err, isErr, isDefect } from "unthrown";
import { _internal_makeAsyncResult } from "./result-async.js";

class TestError extends Error {
  constructor(public readonly tag: string) {
    super(`TestError(${tag})`);
    this.name = "TestError";
  }
}

describe("_internal_makeAsyncResult", () => {
  it("returns ok(...) when the work function resolves with ok(...)", async () => {
    const result = await _internal_makeAsyncResult<number, TestError>(async () => ok(42));
    expect(result).toBeOkWith(42);
  });

  it("returns err(...) unchanged when the work function resolves with err(...)", async () => {
    const domainError = new TestError("domain");
    const result = await _internal_makeAsyncResult<number, TestError>(async () => err(domainError));
    expect(result).toBeErr();
    if (isErr(result)) {
      // Identity preserved — the domain `err(...)` flows through untouched.
      expect(result.error).toBe(domainError);
    }
  });

  it("routes a rejected promise through the defect channel", async () => {
    // Without the helper, a rejected promise would surface as an unhandled
    // rejection — an *unanticipated* failure becomes a defect instead.
    const thrown = new Error("kaboom");
    const result = await _internal_makeAsyncResult<number, TestError>(async () => {
      // Force at least one microtask before throwing so this exercises the
      // rejection branch (vs. the synchronous-throw branch covered below).
      await Promise.resolve();
      throw thrown;
    });
    expect(result).toBeDefect();
    if (isDefect(result)) {
      expect(result.cause).toBe(thrown);
    }
  });

  it("routes a synchronous throw before the first await through the defect channel", async () => {
    // A non-async wrapper that throws *before* returning a promise —
    // `fromSafePromise` invokes the thunk and captures the synchronous throw as
    // a defect rather than letting it bubble out of the helper.
    const thrown = new Error("sync-blow-up");
    const result = await _internal_makeAsyncResult<number, TestError>(() => {
      throw thrown;
    });
    expect(result).toBeDefect();
    if (isDefect(result)) {
      expect(result.cause).toBe(thrown);
    }
  });

  it("preserves a non-Error thrown value on the defect's cause", async () => {
    // Throwing a non-Error is legal in JS — the defect must carry the raw
    // thrown value untouched.
    const thrown = { kind: "non-error-throwable" };
    const result = await _internal_makeAsyncResult<number, TestError>(async () => {
      await Promise.resolve();
      throw thrown;
    });
    expect(result).toBeDefect();
    if (isDefect(result)) {
      expect(result.cause).toBe(thrown);
    }
  });
});
