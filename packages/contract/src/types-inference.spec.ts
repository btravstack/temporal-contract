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

import {
  defineContract,
  defineActivity,
  defineQuery,
  defineSignal,
  defineUpdate,
  defineWorkflow,
} from "./builder.js";
import type {
  ClientInferInput,
  ClientInferOutput,
  InferActivityNames,
  InferWorkflowNames,
  QueryNamesOf,
  SearchAttributeKindToType,
  SignalNamesOf,
  UpdateNamesOf,
  WorkerInferInput,
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

  it("name helpers distribute over union workflow types (signals)", () => {
    const wfA = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      signals: {
        cancel: defineSignal({ input: z.object({ reason: z.string() }) }),
      },
    });
    const wfB = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      signals: {
        pause: defineSignal({ input: z.object({}) }),
      },
    });

    type Union = typeof wfA | typeof wfB;
    type Names = SignalNamesOf<Union>;

    // Distributive: union of each variant's signal names, not the
    // intersection (which `keyof (A | B)` would otherwise produce).
    expectTypeOf<Names>().toEqualTypeOf<"cancel" | "pause">();
  });

  it("name helpers distribute over union workflow types (queries + updates)", () => {
    const wfA = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      queries: {
        getStatus: defineQuery({ input: z.object({}), output: z.string() }),
      },
      updates: {
        bump: defineUpdate({ input: z.object({}), output: z.number() }),
      },
    });
    const wfB = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      queries: {
        getCount: defineQuery({ input: z.object({}), output: z.number() }),
      },
      updates: {
        reset: defineUpdate({ input: z.object({}), output: z.void() }),
      },
    });

    type Union = typeof wfA | typeof wfB;

    expectTypeOf<QueryNamesOf<Union>>().toEqualTypeOf<"getStatus" | "getCount">();
    expectTypeOf<UpdateNamesOf<Union>>().toEqualTypeOf<"bump" | "reset">();
  });

  it("QueryNamesOf yields the declared query-name union", () => {
    const wf = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      queries: {
        getStatus: defineQuery({ input: z.object({}), output: z.string() }),
      },
    });
    expectTypeOf<QueryNamesOf<typeof wf>>().toEqualTypeOf<"getStatus">();
  });

  it("UpdateNamesOf yields the declared update-name union", () => {
    const wf = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      updates: {
        bump: defineUpdate({ input: z.object({}), output: z.number() }),
      },
    });
    expectTypeOf<UpdateNamesOf<typeof wf>>().toEqualTypeOf<"bump">();
  });
});

describe("input-less signal/query/update definitions", () => {
  it("defineSignal() infers the handler input as undefined on both faces", () => {
    const shutdown = defineSignal();
    expectTypeOf<WorkerInferInput<typeof shutdown>>().toEqualTypeOf<undefined>();
    expectTypeOf<ClientInferInput<typeof shutdown>>().toEqualTypeOf<undefined>();
  });

  it("defineSignal({}) behaves like defineSignal()", () => {
    const shutdown = defineSignal({});
    expectTypeOf<WorkerInferInput<typeof shutdown>>().toEqualTypeOf<undefined>();
  });

  it("defineQuery without input infers input undefined and keeps the output type", () => {
    const getStatus = defineQuery({ output: z.string() });
    expectTypeOf<WorkerInferInput<typeof getStatus>>().toEqualTypeOf<undefined>();
    expectTypeOf<ClientInferInput<typeof getStatus>>().toEqualTypeOf<undefined>();
    expectTypeOf<ClientInferOutput<typeof getStatus>>().toEqualTypeOf<string>();
  });

  it("defineUpdate without input infers input undefined and keeps the output type", () => {
    const bump = defineUpdate({ output: z.number() });
    expectTypeOf<WorkerInferInput<typeof bump>>().toEqualTypeOf<undefined>();
    expectTypeOf<ClientInferOutput<typeof bump>>().toEqualTypeOf<number>();
  });

  it("input-less definitions still satisfy the workflow definition constraints", () => {
    const wf = defineWorkflow({
      input: z.object({}),
      output: z.object({}),
      signals: { shutdown: defineSignal() },
      queries: { getStatus: defineQuery({ output: z.string() }) },
      updates: { bump: defineUpdate({ output: z.number() }) },
    });
    expectTypeOf<SignalNamesOf<typeof wf>>().toEqualTypeOf<"shutdown">();
    expectTypeOf<QueryNamesOf<typeof wf>>().toEqualTypeOf<"getStatus">();
    expectTypeOf<UpdateNamesOf<typeof wf>>().toEqualTypeOf<"bump">();
  });
});
