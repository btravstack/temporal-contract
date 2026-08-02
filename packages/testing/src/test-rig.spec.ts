import { ContractClient } from "@temporal-contract/client";
import { describe, expect, it } from "vitest";

import {
  extractStartedWorkflowId,
  isTerminalStatus,
  skipReasonFor,
  START_METHODS,
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

  it("returns undefined against an empty allowlist — testRig's own default", () => {
    expect(skipReasonFor("anything", {})).toBeUndefined();
  });
});

describe("START_METHODS", () => {
  it("names exactly ContractClient's start-capable public methods", () => {
    // `createTypedHandle` is `private` in the TypeScript source, but
    // `private` is compile-time only — it still shows up in runtime
    // reflection below, so it's named and excluded explicitly rather than
    // silently swallowed by some naming convention that could just as
    // easily hide a real public method in the future.
    const PRIVATE_HELPER = "createTypedHandle";
    // `getHandle` is ContractClient's one public method that does NOT start
    // an execution — everything else public is in START_METHODS.
    const NON_START_METHOD = "getHandle";

    const publicMethods = Object.getOwnPropertyNames(ContractClient.prototype).filter((name) => {
      if (name === "constructor" || name === PRIVATE_HELPER) return false;
      // `getOwnPropertyDescriptor` (rather than direct property access)
      // avoids invoking `taskQueue`'s getter on the bare prototype, which
      // has no bound instance state and would throw.
      const descriptor = Object.getOwnPropertyDescriptor(ContractClient.prototype, name);
      return typeof descriptor?.value === "function";
    });

    expect(new Set(publicMethods)).toEqual(new Set([...START_METHODS, NON_START_METHOD]));
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
