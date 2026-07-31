import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { nextTaskQueueId, withTaskQueue } from "./workflow-bundle.js";

const contract = defineContract({
  taskQueue: "original-queue",
  workflows: {
    noop: defineWorkflow({ input: z.object({}), output: z.object({}) }),
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

describe("nextTaskQueueId", () => {
  it("returns a distinct id on each call", () => {
    const a = nextTaskQueueId("t");
    const b = nextTaskQueueId("t");

    expect(a).not.toBe(b);
    expect(a.startsWith("t-")).toBe(true);
  });
});
