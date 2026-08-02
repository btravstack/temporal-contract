import { describe, expect, it } from "vitest";

import {
  extractStartedWorkflowId,
  isTerminalStatus,
  REPLAY_SKIP_ALLOWLIST,
  skipReasonFor,
} from "./test-rig.js";

describe("isTerminalStatus", () => {
  it("treats every finished status as terminal", () => {
    for (const name of ["COMPLETED", "FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT"]) {
      expect(isTerminalStatus(name)).toBe(true);
    }
  });

  it("treats CONTINUED_AS_NEW as terminal — that run's history is complete and replayable", () => {
    expect(isTerminalStatus("CONTINUED_AS_NEW")).toBe(true);
  });

  it("treats unfinished statuses as non-terminal", () => {
    for (const name of ["RUNNING", "PAUSED", "UNSPECIFIED", "UNKNOWN"]) {
      expect(isTerminalStatus(name)).toBe(false);
    }
  });
});

describe("skipReasonFor", () => {
  it("matches an allowlist entry by workflow-ID prefix", () => {
    expect(skipReasonFor("probe-edge-cases-1", { "probe-edge-cases": "blocks forever" })).toBe(
      "blocks forever",
    );
  });

  it("returns undefined for an unlisted id, so the caller can fail", () => {
    expect(
      skipReasonFor("some-other-id", { "probe-edge-cases": "blocks forever" }),
    ).toBeUndefined();
  });

  it("ships an allowlist whose every entry carries a non-empty reason", () => {
    for (const [prefix, reason] of Object.entries(REPLAY_SKIP_ALLOWLIST)) {
      expect(reason, `allowlist entry "${prefix}" needs a reason`).not.toBe("");
    }
  });
});

describe("extractStartedWorkflowId", () => {
  it("extracts the workflowId from the options bag at args[1]", () => {
    expect(
      extractStartedWorkflowId("startWorkflow", ["myWorkflow", { workflowId: "order-123" }]),
    ).toBe("order-123");
  });

  it("throws naming the method and the received bag when workflowId is missing", () => {
    expect(() => extractStartedWorkflowId("startWorkflow", ["myWorkflow", {}])).toThrow(
      /startWorkflow.*workflowId/s,
    );
  });

  it("throws when the second argument isn't an object at all", () => {
    expect(() => extractStartedWorkflowId("executeWorkflow", ["myWorkflow", undefined])).toThrow(
      /executeWorkflow.*workflowId/s,
    );
  });

  it("throws when workflowId is present but not a string", () => {
    expect(() =>
      extractStartedWorkflowId("signalWithStart", ["myWorkflow", { workflowId: 123 }]),
    ).toThrow(/signalWithStart.*workflowId/s);
  });
});
