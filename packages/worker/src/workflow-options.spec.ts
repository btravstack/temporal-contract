/**
 * Type-level coverage for `declareWorkflow`'s `activityOptionsByName`.
 *
 * The runtime behaviour is covered by the integration suite under
 * `__tests__/`. This file pins the compile-time guarantee that override
 * keys are constrained to declared activity names — typos surface as
 * type errors rather than running silently with the default options.
 */
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import type { ActivityOptions } from "@temporalio/workflow";
import { declareWorkflow } from "./workflow.js";

const contract = defineContract({
  taskQueue: "tq",
  workflows: {
    processOrder: defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      activities: {
        chargePayment: defineActivity({
          input: z.object({ amount: z.number() }),
          output: z.object({ ok: z.boolean() }),
        }),
        validateOrder: defineActivity({
          input: z.object({ orderId: z.string() }),
          output: z.object({ valid: z.boolean() }),
        }),
      },
    }),
    other: defineWorkflow({
      input: z.object({}),
      output: z.object({}),
    }),
  },
  activities: {
    log: defineActivity({
      input: z.object({ message: z.string() }),
      output: z.object({}),
    }),
  },
});

type ProcessOrderOptions = Parameters<typeof declareWorkflow<typeof contract, "processOrder">>[0];

describe("declareWorkflow activityOptionsByName", () => {
  it("keys cover workflow-local + global activities", () => {
    expectTypeOf<keyof NonNullable<ProcessOrderOptions["activityOptionsByName"]>>().toEqualTypeOf<
      "chargePayment" | "validateOrder" | "log"
    >();
  });

  it("values are ActivityOptions", () => {
    expectTypeOf<
      NonNullable<ProcessOrderOptions["activityOptionsByName"]>["chargePayment"]
    >().toEqualTypeOf<ActivityOptions | undefined>();
  });

  it("falls back to just global activities for workflows without local ones", () => {
    type OtherOptions = Parameters<typeof declareWorkflow<typeof contract, "other">>[0];
    expectTypeOf<keyof NonNullable<OtherOptions["activityOptionsByName"]>>().toEqualTypeOf<"log">();
  });

  it("rejects unknown activity names at compile time", () => {
    const _bad: ProcessOrderOptions["activityOptionsByName"] = {
      // @ts-expect-error — `processPayment` is not a declared activity for processOrder.
      processPayment: { startToCloseTimeout: "1 minute" },
    };
    void _bad;
  });

  it("activityOptionsByName is optional", () => {
    expectTypeOf<ProcessOrderOptions["activityOptionsByName"]>().toEqualTypeOf<
      Partial<Record<"chargePayment" | "validateOrder" | "log", ActivityOptions>> | undefined
    >();
  });
});
