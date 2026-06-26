/**
 * Coverage for the typed cancellation-scope helpers
 * ({@link cancellableScope}, {@link nonCancellableScope}).
 *
 * Mocks `@temporalio/workflow` so the helpers can be exercised outside a
 * real workflow context. Asserts that:
 * - successful resolution surfaces as `ok`,
 * - cancellation surfaces as `err(WorkflowCancelledError)`
 *   (matched via the mocked `isCancellation` predicate),
 * - non-cancellation errors are *unmodeled* failures and surface on the
 *   `defect` channel with the original error on `cause` — they no longer ride
 *   the modeled error channel, since a thrown non-cancellation error is a bug
 *   rather than an anticipated domain outcome,
 * - synchronous throws thrown before the first `await` of the work function
 *   are likewise captured as defects rather than escaping as an unhandled
 *   rejection,
 * - the helpers route through `CancellationScope.cancellable` /
 *   `CancellationScope.nonCancellable` respectively.
 *
 * Closes #183.
 */
import { describe, expect, it, vi } from "vitest";
import { isOk, isErr, isDefect } from "unthrown";
import { z } from "zod";
import { defineContract, defineWorkflow } from "@temporal-contract/contract";

const CANCEL_MARKER = "__CANCEL__";

// `declareWorkflow` calls `workflowInfo()` while building the context, so the
// wiring test below needs it stubbed alongside the cancellation primitives.
vi.mock("@temporalio/workflow", () => ({
  CancellationScope: {
    cancellable: vi.fn(<T>(fn: () => Promise<T>): Promise<T> => fn()),
    nonCancellable: vi.fn(<T>(fn: () => Promise<T>): Promise<T> => fn()),
  },
  isCancellation: (err: unknown) => err instanceof Error && err.message === CANCEL_MARKER,
  workflowInfo: () => ({ workflowId: "test-wf", runId: "test-run" }),
}));

const { CancellationScope } = await import("@temporalio/workflow");
const { cancellableScope, nonCancellableScope } = await import("./cancellation.js");
const { declareWorkflow } = await import("./workflow.js");
const { WorkflowCancelledError } = await import("./errors.js");

describe("cancellableScope", () => {
  it("returns Result.Ok with the resolved value on success", async () => {
    const result = await cancellableScope(async () => 42);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
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
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(WorkflowCancelledError);
      // Cause is preserved so debug tooling can see the underlying failure.
      expect((result.error.cause as Error).message).toBe(CANCEL_MARKER);
    }
  });

  it("routes a non-cancellation error to the defect channel", async () => {
    // A thrown non-cancellation error is an *unmodeled* failure: the helper
    // re-throws it so the `makeResultAsync` boundary captures it as a defect,
    // with the original error on `cause`, rather than a typed err(...).
    const original = new Error("activity exploded");
    const result = await cancellableScope(async () => {
      throw original;
    });
    expect(isDefect(result)).toBe(true);
    if (isDefect(result)) {
      expect(result.cause).toBe(original);
    }
  });

  it("captures synchronous throws from the work body as a defect", async () => {
    // If `fn` throws *before* its first await, `fromPromise`'s thunk form still
    // captures it — as a defect carrying the original cause.
    const original = new Error("sync explosion");
    const result = await cancellableScope(() => {
      throw original;
    });
    expect(isDefect(result)).toBe(true);
    if (isDefect(result)) {
      expect(result.cause).toBe(original);
    }
  });
});

describe("nonCancellableScope", () => {
  it("returns Result.Ok with the resolved value on success", async () => {
    const result = await nonCancellableScope(async () => "released");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
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
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(WorkflowCancelledError);
    }
  });

  it("routes a non-cancellation error to the defect channel", async () => {
    const original = new Error("cleanup failure");
    const result = await nonCancellableScope(async () => {
      throw original;
    });
    expect(isDefect(result)).toBe(true);
    if (isDefect(result)) {
      expect(result.cause).toBe(original);
    }
  });

  it("captures synchronous throws from the work body as a defect", async () => {
    const original = new Error("sync cleanup explosion");
    const result = await nonCancellableScope(() => {
      throw original;
    });
    expect(isDefect(result)).toBe(true);
    if (isDefect(result)) {
      expect(result.cause).toBe(original);
    }
  });
});

describe("scope helpers accept synchronous callbacks", () => {
  // The implementation `await`s the callback result, so a non-Promise return
  // is valid at runtime. The public type was widened to `() => T | Promise<T>`
  // so workflows mutating purely-local state don't have to write `async () =>`.
  it("cancellableScope wraps a sync return as Result.Ok", async () => {
    const result = await cancellableScope(() => "sync-ok");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe("sync-ok");
    }
  });

  it("nonCancellableScope wraps a sync return as Result.Ok", async () => {
    const result = await nonCancellableScope(() => 7);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toBe(7);
    }
  });
});

describe("declareWorkflow context wiring", () => {
  // Regression guard: a refactor that drops the cancellation helpers off the
  // constructed `context` would still leave the helper unit tests above green
  // while breaking the public workflow API. This asserts the wiring directly.
  const wiringContract = defineContract({
    taskQueue: "wiring-q",
    workflows: {
      probe: defineWorkflow({
        input: z.object({ x: z.string() }),
        output: z.object({ ok: z.boolean() }),
      }),
    },
  });

  it("mounts cancellableScope and nonCancellableScope on the context passed to the implementation", async () => {
    let captured: unknown;
    const handler = declareWorkflow({
      workflowName: "probe",
      contract: wiringContract,
      activityOptions: {},
      implementation: async (context) => {
        captured = context;
        return { ok: true };
      },
    });

    await handler({ x: "value" });

    expect(captured).toBeDefined();
    const ctx = captured as {
      cancellableScope?: typeof cancellableScope;
      nonCancellableScope?: typeof nonCancellableScope;
    };
    // Identity check — the helpers in the context are exactly the exports
    // from `cancellation.ts`, not lookalike wrappers built per-execution.
    expect(ctx.cancellableScope).toBe(cancellableScope);
    expect(ctx.nonCancellableScope).toBe(nonCancellableScope);
  });
});
