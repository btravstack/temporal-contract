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
import { defineContract, defineActivity, defineSignal, defineWorkflow } from "./builder.js";
import type {
  InferActivityNames,
  InferContractWorkflows,
  InferWorkflowNames,
  QueryNamesOf,
  SearchAttributeKindToType,
  SignalNamesOf,
  UpdateNamesOf,
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

describe("WorkflowDefinition generic preservation (audit fix #2)", () => {
  it("defineWorkflow preserves the input/output schema literal types", () => {
    const wf = defineWorkflow({
      input: z.object({ a: z.string() }),
      output: z.string(),
    });

    // Before the fix, these were widened to `AnySchema`/`StandardSchemaV1`
    // and downstream `ClientInferInput<…>` resolved to `unknown`.
    expectTypeOf<typeof wf.input>().toEqualTypeOf<z.ZodObject<{ a: z.ZodString }>>();
    expectTypeOf<typeof wf.output>().toEqualTypeOf<z.ZodString>();
  });

  it("a workflow's `args` infers to its input schema (not unknown) inside a contract", () => {
    const contract = defineContract({
      taskQueue: "q",
      workflows: {
        p: defineWorkflow({
          input: z.object({ a: z.string() }),
          output: z.string(),
        }),
      },
    });

    type WorkflowInput = z.input<(typeof contract)["workflows"]["p"]["input"]>;
    expectTypeOf<WorkflowInput>().toEqualTypeOf<{ a: string }>();
  });
});

describe("Signal/query/update name helpers (audit fix #3)", () => {
  const contractWithSignal = defineContract({
    taskQueue: "q",
    workflows: {
      hasSignal: defineWorkflow({
        input: z.object({}),
        output: z.object({}),
        signals: {
          cancel: defineSignal({ input: z.object({ reason: z.string() }) }),
        },
      }),
    },
  });

  const contractNoInteractions = defineContract({
    taskQueue: "q",
    workflows: {
      bare: defineWorkflow({
        input: z.object({}),
        output: z.object({}),
      }),
    },
  });

  it("SignalNamesOf yields the declared signal-name union", () => {
    type Names = SignalNamesOf<(typeof contractWithSignal)["workflows"]["hasSignal"]>;
    expectTypeOf<Names>().toEqualTypeOf<"cancel">();
  });

  it("SignalNamesOf is `never` when the workflow declares no signals", () => {
    type Names = SignalNamesOf<(typeof contractNoInteractions)["workflows"]["bare"]>;
    expectTypeOf<Names>().toEqualTypeOf<never>();
  });

  it("QueryNamesOf is `never` when the workflow declares no queries", () => {
    type Names = QueryNamesOf<(typeof contractNoInteractions)["workflows"]["bare"]>;
    expectTypeOf<Names>().toEqualTypeOf<never>();
  });

  it("UpdateNamesOf is `never` when the workflow declares no updates", () => {
    type Names = UpdateNamesOf<(typeof contractNoInteractions)["workflows"]["bare"]>;
    expectTypeOf<Names>().toEqualTypeOf<never>();
  });
});
