/**
 * Coverage for the typed cancellation-scope helpers
 * ({@link cancellableScope}, {@link nonCancellableScope}).
 *
 * Mocks `@temporalio/workflow` so the helpers can be exercised outside a
 * real workflow context. Asserts that:
 * - successful resolution surfaces as `Result.Ok`,
 * - cancellation surfaces as `Result.Error(WorkflowCancelledError)`
 *   (matched via the mocked `isCancellation` predicate),
 * - non-cancellation errors propagate as Future rejections rather than
 *   being silently wrapped,
 * - the helpers route through `CancellationScope.cancellable` /
 *   `CancellationScope.nonCancellable` respectively.
 *
 * Closes #183.
 */
import { describe, expect, it, vi } from "vitest";

const CANCEL_MARKER = "__CANCEL__";

vi.mock("@temporalio/workflow", () => ({
  CancellationScope: {
    cancellable: vi.fn(<T>(fn: () => Promise<T>): Promise<T> => fn()),
    nonCancellable: vi.fn(<T>(fn: () => Promise<T>): Promise<T> => fn()),
  },
  isCancellation: (err: unknown) => err instanceof Error && err.message === CANCEL_MARKER,
}));

const { CancellationScope } = await import("@temporalio/workflow");
const { cancellableScope, nonCancellableScope } = await import("./cancellation.js");
const { WorkflowCancelledError } = await import("./errors.js");

describe("cancellableScope", () => {
  it("returns Result.Ok with the resolved value on success", async () => {
    const result = await cancellableScope(async () => 42);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(42);
    }
  });

  it("routes the function through CancellationScope.cancellable", async () => {
    vi.mocked(CancellationScope.cancellable).mockClear();
    await cancellableScope(async () => "ok");
    expect(CancellationScope.cancellable).toHaveBeenCalledTimes(1);
  });

  it("returns Result.Error(WorkflowCancelledError) when cancellation is raised", async () => {
    const result = await cancellableScope(async () => {
      throw new Error(CANCEL_MARKER);
    });
    expect(result.isError()).toBe(true);
    if (result.isError()) {
      expect(result.error).toBeInstanceOf(WorkflowCancelledError);
      // Cause is preserved so debug tooling can see the underlying failure.
      expect((result.error.cause as Error).message).toBe(CANCEL_MARKER);
    }
  });

  it("propagates non-cancellation errors as Future rejections (not wrapped)", async () => {
    const original = new Error("activity exploded");
    await expect(
      cancellableScope(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });
});

describe("nonCancellableScope", () => {
  it("returns Result.Ok with the resolved value on success", async () => {
    const result = await nonCancellableScope(async () => "released");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe("released");
    }
  });

  it("routes the function through CancellationScope.nonCancellable", async () => {
    vi.mocked(CancellationScope.nonCancellable).mockClear();
    await nonCancellableScope(async () => undefined);
    expect(CancellationScope.nonCancellable).toHaveBeenCalledTimes(1);
  });

  it("still folds an internally-raised cancellation into Result.Error", async () => {
    // The whole point of nonCancellable is that *outside* cancels are ignored,
    // but a CancelledFailure raised by code inside the scope should still
    // surface explicitly rather than as a thrown error.
    const result = await nonCancellableScope(async () => {
      throw new Error(CANCEL_MARKER);
    });
    expect(result.isError()).toBe(true);
    if (result.isError()) {
      expect(result.error).toBeInstanceOf(WorkflowCancelledError);
    }
  });

  it("propagates non-cancellation errors as Future rejections", async () => {
    const original = new Error("cleanup failure");
    await expect(
      nonCancellableScope(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });
});
