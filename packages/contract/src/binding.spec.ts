import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { defineContractBinding } from "./binding.js";
import {
  ContractDefinitionError,
  defineActivity,
  defineContract,
  defineWorkflow,
} from "./builder.js";

describe("defineContractBinding", () => {
  it("preserves protocol definitions and source queue while binding independent deployments", () => {
    const activity = defineActivity({ input: z.string(), output: z.string() });
    const workflow = defineWorkflow({
      input: z.string(),
      output: z.string(),
      startPolicy: "once-per-id",
      activities: { activity },
    });
    const contract = defineContract({ taskQueue: "logical", workflows: { run: workflow } });
    const first = defineContractBinding(contract, { taskQueue: "release-a" });
    const second = defineContractBinding(contract, { taskQueue: "release-b" });

    expect({
      source: contract.taskQueue,
      first: first.taskQueue,
      second: second.taskQueue,
      sameDefinitions:
        first.workflows === contract.workflows && second.workflows === contract.workflows,
    }).toEqual({
      source: "logical",
      first: "release-a",
      second: "release-b",
      sameDefinitions: true,
    });
    expectTypeOf(first.taskQueue).toEqualTypeOf<"release-a">();
    expectTypeOf(first.workflows).toEqualTypeOf(contract.workflows);
  });

  it.each(["", " ", " queue", "queue ", "q".repeat(1001)])(
    "rejects invalid task queue %j",
    (taskQueue) => {
      const noop = defineActivity({ input: z.string(), output: z.string() });
      const contract = defineContract({
        taskQueue: "logical",
        workflows: {},
        activities: { noop },
      });
      expect(() => defineContractBinding(contract, { taskQueue })).toThrow(ContractDefinitionError);
    },
  );
});
