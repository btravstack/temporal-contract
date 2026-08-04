import { describe, expect, it } from "vitest";

import { reusePolicyFor } from "./idempotency.js";

describe("reusePolicyFor", () => {
  it("maps once-per-id to REJECT_DUPLICATE — the ID may run exactly once, ever", () => {
    expect(reusePolicyFor("once-per-id")).toBe("REJECT_DUPLICATE");
  });

  it("maps retry-if-failed to ALLOW_DUPLICATE_FAILED_ONLY — re-runnable only after a non-success", () => {
    expect(reusePolicyFor("retry-if-failed")).toBe("ALLOW_DUPLICATE_FAILED_ONLY");
  });

  it("maps allow-duplicate to ALLOW_DUPLICATE — Temporal's default, chosen deliberately", () => {
    expect(reusePolicyFor("allow-duplicate")).toBe("ALLOW_DUPLICATE");
  });

  it("maps every declared mode — a new mode without a mapping is a compile error", () => {
    // `Record<IdempotencyMode, …>` in the implementation makes an unmapped
    // mode fail to compile. This test pins the runtime side: every mode
    // produces a policy string, none produces undefined.
    const modes = ["once-per-id", "retry-if-failed", "allow-duplicate"] as const;
    for (const mode of modes) {
      expect(typeof reusePolicyFor(mode)).toBe("string");
    }
  });
});
