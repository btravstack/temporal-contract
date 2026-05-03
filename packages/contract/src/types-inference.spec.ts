/**
 * Type-level tests. Failures here surface as `tsc --noEmit` errors, not as
 * runtime failures, so these guard the type machinery against regression.
 *
 * Vitest's `expectTypeOf` is a value at runtime but its assertion is purely
 * compile-time; we still wrap each one in `it(...)` so the type-checker visits
 * this file under the unit project.
 */
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { defineContract, defineActivity } from "./builder.js";
import type {
  InferActivityNames,
  InferContractWorkflows,
  InferWorkflowNames,
  SearchAttributeKindToType,
} from "./types.js";

const contract = defineContract({
  taskQueue: "orders",
  workflows: {
    processOrder: {
      input: z.object({ orderId: z.string() }),
      output: z.object({ success: z.boolean() }),
    },
    sendNotification: {
      input: z.object({ userId: z.string() }),
      output: z.void(),
    },
  },
  activities: {
    log: {
      input: z.object({ message: z.string() }),
      output: z.void(),
    },
    sendEmail: {
      input: z.object({ to: z.string() }),
      output: z.object({ messageId: z.string() }),
    },
  },
});

describe("contract inference utilities", () => {
  it("InferWorkflowNames yields a union of workflow keys", () => {
    expectTypeOf<InferWorkflowNames<typeof contract>>().toEqualTypeOf<
      "processOrder" | "sendNotification"
    >();
  });

  it("InferActivityNames yields a union of global activity keys", () => {
    expectTypeOf<InferActivityNames<typeof contract>>().toEqualTypeOf<"log" | "sendEmail">();
  });

  it("InferActivityNames is never when no global activities exist", () => {
    const noActivities = defineContract({
      taskQueue: "q",
      workflows: {
        wf: {
          input: z.object({}),
          output: z.object({}),
        },
      },
    });
    expectTypeOf<InferActivityNames<typeof noActivities>>().toEqualTypeOf<never>();
  });

  it("InferContractWorkflows preserves workflow definitions", () => {
    type Workflows = InferContractWorkflows<typeof contract>;
    expectTypeOf<keyof Workflows>().toEqualTypeOf<"processOrder" | "sendNotification">();
    expectTypeOf<Workflows["processOrder"]["input"]>().toEqualTypeOf<
      (typeof contract)["workflows"]["processOrder"]["input"]
    >();
  });

  it("defineActivity preserves the literal schema types", () => {
    const charge = defineActivity({
      input: z.object({ amount: z.number() }),
      output: z.object({ transactionId: z.string() }),
    });
    expectTypeOf<typeof charge.input>().toEqualTypeOf<z.ZodObject<{ amount: z.ZodNumber }>>();
  });

  it("SearchAttributeKindToType maps each kind to the expected TS type", () => {
    expectTypeOf<SearchAttributeKindToType<"TEXT">>().toEqualTypeOf<string>();
    expectTypeOf<SearchAttributeKindToType<"KEYWORD">>().toEqualTypeOf<string>();
    expectTypeOf<SearchAttributeKindToType<"INT">>().toEqualTypeOf<number>();
    expectTypeOf<SearchAttributeKindToType<"DOUBLE">>().toEqualTypeOf<number>();
    expectTypeOf<SearchAttributeKindToType<"BOOL">>().toEqualTypeOf<boolean>();
    expectTypeOf<SearchAttributeKindToType<"DATETIME">>().toEqualTypeOf<Date>();
    expectTypeOf<SearchAttributeKindToType<"KEYWORD_LIST">>().toEqualTypeOf<string[]>();
  });
});
