import type { ActivityOptions } from "@temporalio/workflow";
import { describe, expect, it } from "vitest";

import {
  formatUnboundedActivitiesMessage,
  hasPerAttemptBound,
  hasTotalBound,
  missingBounds,
} from "./activity-bounds.js";

describe("hasPerAttemptBound", () => {
  it("accepts startToCloseTimeout", () => {
    expect(hasPerAttemptBound({ startToCloseTimeout: "1 minute" })).toBe(true);
  });

  it("accepts scheduleToCloseTimeout", () => {
    expect(hasPerAttemptBound({ scheduleToCloseTimeout: "1 minute" })).toBe(true);
  });

  it("rejects an options bag with neither", () => {
    expect(hasPerAttemptBound({ retry: { maximumAttempts: 3 } })).toBe(false);
  });

  it("rejects an empty options bag", () => {
    expect(hasPerAttemptBound({})).toBe(false);
  });
});

describe("hasTotalBound", () => {
  it("accepts scheduleToCloseTimeout", () => {
    expect(hasTotalBound({ scheduleToCloseTimeout: "10 minutes" })).toBe(true);
  });

  it("accepts a finite positive integer maximumAttempts", () => {
    expect(hasTotalBound({ startToCloseTimeout: "1m", retry: { maximumAttempts: 3 } })).toBe(true);
  });

  it("rejects startToCloseTimeout alone — it bounds one attempt, not the sequence", () => {
    expect(hasTotalBound({ startToCloseTimeout: "1 minute" })).toBe(false);
  });

  it("rejects Infinity — Temporal drops it because it IS the default", () => {
    expect(
      hasTotalBound({
        startToCloseTimeout: "1m",
        retry: { maximumAttempts: Number.POSITIVE_INFINITY },
      }),
    ).toBe(false);
  });

  it("rejects zero", () => {
    expect(hasTotalBound({ startToCloseTimeout: "1m", retry: { maximumAttempts: 0 } })).toBe(false);
  });

  it("rejects a negative count", () => {
    expect(hasTotalBound({ startToCloseTimeout: "1m", retry: { maximumAttempts: -1 } })).toBe(
      false,
    );
  });

  it("rejects a non-integer count", () => {
    expect(hasTotalBound({ startToCloseTimeout: "1m", retry: { maximumAttempts: 2.5 } })).toBe(
      false,
    );
  });

  it("rejects a retry block with no maximumAttempts", () => {
    expect(hasTotalBound({ startToCloseTimeout: "1m", retry: { initialInterval: "2s" } })).toBe(
      false,
    );
  });
});

describe("missingBounds", () => {
  it("reports both when the bag is empty", () => {
    expect(missingBounds({})).toEqual(["per-attempt", "total"]);
  });

  it("reports only the total bound when startToCloseTimeout is set alone", () => {
    expect(missingBounds({ startToCloseTimeout: "1 minute" })).toEqual(["total"]);
  });

  it("reports only the per-attempt bound when maximumAttempts is set alone", () => {
    expect(missingBounds({ retry: { maximumAttempts: 3 } })).toEqual(["per-attempt"]);
  });

  it("reports nothing when scheduleToCloseTimeout satisfies both", () => {
    const options: ActivityOptions = { scheduleToCloseTimeout: "10 minutes" };
    expect(missingBounds(options)).toEqual([]);
  });
});

describe("formatUnboundedActivitiesMessage", () => {
  it("names every offending activity and the bound it lacks", () => {
    const message = formatUnboundedActivitiesMessage([
      { name: "chargeCard", missing: ["per-attempt", "total"] },
      { name: "sendReceipt", missing: ["total"] },
    ]);

    expect(message).toContain("chargeCard");
    expect(message).toContain("sendReceipt");
    // The remedy for each rule must be stated, not just the rule name.
    expect(message).toContain("startToCloseTimeout");
    expect(message).toContain("retry.maximumAttempts");
    // The shallow-merge footgun is the non-obvious cause; the message must say so.
    expect(message).toContain("shallow");
  });

  it("does not mention a bound the activity actually has", () => {
    const message = formatUnboundedActivitiesMessage([{ name: "sendReceipt", missing: ["total"] }]);
    expect(message).not.toContain("per-attempt bound");
  });
});
