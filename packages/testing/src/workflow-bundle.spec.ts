import { fileURLToPath } from "node:url";

import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { bundleFor, fixturePath, nextTaskQueueId, withTaskQueue } from "./workflow-bundle.js";

const contract = defineContract({
  taskQueue: "original-queue",
  workflows: {
    noop: defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      idempotency: "allow-duplicate",
    }),
  },
});

describe("withTaskQueue", () => {
  it("replaces the task queue without mutating the original contract", () => {
    const scoped = withTaskQueue(contract, "q-1");

    expect(scoped.taskQueue).toBe("q-1");
    expect(contract.taskQueue).toBe("original-queue");
    expect(scoped.workflows).toBe(contract.workflows);
  });
});

describe("bundleFor", () => {
  // These paths never resolve to a real module — that's fine, the property
  // under test is promise *identity* from the cache, not a successful
  // bundle. Each rejection is swallowed so it doesn't surface as an
  // unhandled rejection; a real workflow module is never bundled here, so
  // the tests stay fast.

  it("returns the same promise instance on repeated calls for the same path", () => {
    const path = "/nonexistent/workflow-bundle-fixture-a.js";

    const first = bundleFor(path);
    const second = bundleFor(path);

    // Same instance back proves `bundleWorkflowCode` ran exactly once for
    // this path and the second call hit the cache. Asserting an
    // invocation count directly would require mocking `@temporalio/worker`,
    // which this project disallows — identity is the property that matters.
    expect(second).toBe(first);

    first.catch(() => {
      // Expected: the path doesn't exist.
    });
  });

  it("caches different paths independently", () => {
    const a = bundleFor("/nonexistent/workflow-bundle-fixture-b.js");
    const b = bundleFor("/nonexistent/workflow-bundle-fixture-c.js");

    expect(a).not.toBe(b);

    a.catch(() => {
      // Expected: the path doesn't exist.
    });
    b.catch(() => {
      // Expected: the path doesn't exist.
    });
  });
});

describe("nextTaskQueueId", () => {
  it("returns a distinct id on each call", () => {
    const a = nextTaskQueueId("t");
    const b = nextTaskQueueId("t");

    expect(a).not.toBe(b);
    expect(a.startsWith("t-")).toBe(true);
  });
});

describe("fixturePath", () => {
  it("resolves the filename as a sibling of the given caller URL, not this module's own URL", () => {
    const callerUrl = "file:///project/packages/worker/src/__tests__/example.inprocess.spec.ts";

    const result = fixturePath(callerUrl, "example.workflows");

    expect(result).toBe(fileURLToPath(new URL("./example.workflows.ts", callerUrl)));
  });

  it("derives the extension from the caller URL rather than hard-coding one, so built output resolves too", () => {
    const callerUrl = "file:///project/dist/example.spec.mjs";

    const result = fixturePath(callerUrl, "example.workflows");

    expect(result).toBe(fileURLToPath(new URL("./example.workflows.mjs", callerUrl)));
  });
});
