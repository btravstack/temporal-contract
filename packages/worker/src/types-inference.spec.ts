import {
  defineActivity,
  defineContract,
  defineSignal,
  defineWorkflow,
} from "@temporal-contract/contract";
import { OkAsync } from "unthrown";
/**
 * Type-level tests for the worker- and client-side inference helpers.
 *
 * The library's headline guarantee is that input/output direction is inverted
 * between worker and client perspectives — getting this wrong silently
 * mistypes every call site, so it's worth pinning at the type level.
 *
 * The second half pins the public type surface exported for standalone use:
 * `ActivityImplementationFor`, `WorkflowContext`-typed helpers, stored
 * `TypedChildWorkflowHandle`s, middleware context accumulation,
 * `activityOptionsByName` key constraints, and `continueAsNew` typing.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  composeActivityMiddleware,
  declareActivitiesHandler,
  declareActivityMiddleware,
  type ActivityImplementationFor,
  type ActivityMiddleware,
  type EmptyContext,
  type GlobalActivityImplementationFor,
} from "./activity.js";
import type { TypedChildWorkflowHandle, TypedChildWorkflowOptions } from "./child-workflow.js";
import type {
  ClientInferInput,
  ClientInferOutput,
  WorkerInferInput,
  WorkerInferOutput,
} from "./types.js";
import type { DeclareWorkflowOptions, WorkflowContext } from "./workflow.js";

describe("worker/client inference duality", () => {
  it("on a transforming schema, client sends InferInput, worker receives InferOutput", () => {
    const activity = defineActivity({
      input: z.object({
        timestamp: z.string().transform((s) => new Date(s)),
      }),
      output: z.object({ ok: z.boolean() }),
    });

    expectTypeOf<ClientInferInput<typeof activity>>().toEqualTypeOf<{ timestamp: string }>();
    expectTypeOf<WorkerInferInput<typeof activity>>().toEqualTypeOf<{ timestamp: Date }>();
  });

  it("on a transforming output, worker returns InferInput, client receives InferOutput", () => {
    const activity = defineActivity({
      input: z.object({}),
      output: z.object({
        when: z.date().transform((d) => d.toISOString()),
      }),
    });

    expectTypeOf<WorkerInferOutput<typeof activity>>().toEqualTypeOf<{ when: Date }>();
    expectTypeOf<ClientInferOutput<typeof activity>>().toEqualTypeOf<{ when: string }>();
  });

  it("worker and client inferred types are *not* interchangeable for transforming schemas", () => {
    // Negative test: the whole point of the duality is that these types
    // diverge for transforming schemas. If a future refactor accidentally
    // collapses them, this assertion will fail at compile time.
    const activity = defineActivity({
      input: z.object({
        n: z.string().transform((s) => Number.parseInt(s, 10)),
      }),
      output: z.object({}),
    });

    expectTypeOf<ClientInferInput<typeof activity>>().not.toEqualTypeOf<
      WorkerInferInput<typeof activity>
    >();
  });
});

// ---------------------------------------------------------------------------
// Public type-surface pins (v8): standalone declarations outside the
// declare* factories must typecheck with full inference.
// ---------------------------------------------------------------------------

const validateOrderDef = defineActivity({
  input: z.object({ orderId: z.string() }),
  output: z.object({ valid: z.boolean() }),
});

const logDef = defineActivity({
  input: z.object({ msg: z.string() }),
  output: z.object({}),
});

const orderWorkflowDef = defineWorkflow({
  input: z.object({ id: z.string() }),
  output: z.object({ status: z.string() }),
  idempotency: "allow-duplicate",
  activities: { validateOrder: validateOrderDef },
  signals: {
    cancel: defineSignal({ input: z.object({ reason: z.string() }) }),
  },
});

const otherWorkflowDef = defineWorkflow({
  input: z.object({ batchId: z.string() }),
  output: z.object({ archived: z.boolean() }),
  idempotency: "allow-duplicate",
});

const inferenceContract = defineContract({
  taskQueue: "types-inference",
  workflows: { orderWorkflow: orderWorkflowDef, otherWorkflow: otherWorkflowDef },
  activities: { log: logDef },
});

describe("standalone activity implementations (ActivityImplementationFor)", () => {
  it("resolves the correctly-typed implementation and is accepted by declareActivitiesHandler", async () => {
    // Standalone, workflow-scoped implementation declared OUTSIDE the
    // handler call — args and return channel fully inferred from the
    // contract entry.
    const validateOrder: ActivityImplementationFor<
      typeof inferenceContract,
      "orderWorkflow",
      "validateOrder"
    > = (_, args) => {
      expectTypeOf(args).toEqualTypeOf<{ orderId: string }>();
      return OkAsync({ valid: args.orderId.length > 0 });
    };

    // Global-scope variant.
    const log: GlobalActivityImplementationFor<typeof inferenceContract, "log"> = (_, args) => {
      expectTypeOf(args).toEqualTypeOf<{ msg: string }>();
      return OkAsync({});
    };

    const handler = declareActivitiesHandler({
      contract: inferenceContract,
      activities: {
        log,
        orderWorkflow: { validateOrder },
      },
    });

    // The standalone implementations really registered (runtime smoke).
    expect(await handler.validateOrder({ orderId: "ORD-1" })).toEqual({ valid: true });
    expect(await handler.log({ msg: "hello" })).toEqual({});
  });

  it("rejects an implementation with the wrong output shape", () => {
    const wrong: ActivityImplementationFor<
      typeof inferenceContract,
      "orderWorkflow",
      "validateOrder"
      // @ts-expect-error — output must be { valid: boolean }
    > = () => OkAsync({ nope: true });
    void wrong;
  });
});

describe("WorkflowContext as a standalone helper parameter type", () => {
  it("types activities, handleSignal, and errors on a helper function", () => {
    // Never executed — a pure type-level exercise of the exported context
    // shape (executing would require the workflow sandbox).
    const helper = (context: WorkflowContext<typeof inferenceContract, "orderWorkflow">) => {
      // Typed activities: workflow-local + global merged.
      expectTypeOf(context.activities.validateOrder)
        .parameter(0)
        .toEqualTypeOf<{ orderId: string }>();
      expectTypeOf(context.activities.log).parameter(0).toEqualTypeOf<{ msg: string }>();

      // handleSignal is keyed by the contract's signal names, and the
      // handler's args are the signal's worker-side input type.
      context.handleSignal("cancel", (args) => {
        expectTypeOf(args).toEqualTypeOf<{ reason: string }>();
      });
      // @ts-expect-error — "nope" is not a declared signal
      context.handleSignal("nope", () => {});
    };
    void helper;
    expect(typeof helper).toBe("function");
  });
});

describe("TypedChildWorkflowHandle storage", () => {
  it("a started child handle can be stored under an explicit type annotation", () => {
    const useHandle = async (
      context: WorkflowContext<typeof inferenceContract, "orderWorkflow">,
    ) => {
      let stored:
        | TypedChildWorkflowHandle<(typeof inferenceContract)["workflows"]["otherWorkflow"]>
        | undefined;

      const started = await context.startChildWorkflow(inferenceContract, "otherWorkflow", {
        workflowId: "child-1",
        args: { batchId: "B-1" },
        // Pure type-level exercise; TERMINATE is the pre-8.0.0 default.
        parentClosePolicy: "TERMINATE",
      });
      if (started.isOk()) {
        stored = started.value;
        // The stored handle keeps the child's typed result channel.
        expectTypeOf(stored.workflowId).toEqualTypeOf<string>();
        const result = stored.result();
        expectTypeOf(await result).toMatchTypeOf<{ isOk: () => boolean }>();
      }
      return stored;
    };
    void useHandle;
    expect(typeof useHandle).toBe("function");
  });
});

describe("composeActivityMiddleware context accumulation", () => {
  it("threads the accumulated context type across the chain", () => {
    const chain = composeActivityMiddleware(
      declareActivityMiddleware<EmptyContext, { tenantId: string }>((_invocation, next) =>
        next({ context: { tenantId: "t-1" } }),
      ),
      declareActivityMiddleware<{ tenantId: string }, { tenantId: string; traceId: string }>(
        (invocation, next) => {
          // The upstream stage's out-context is visible here.
          expectTypeOf(invocation.context.tenantId).toEqualTypeOf<string>();
          return next({ context: { ...invocation.context, traceId: "tr-1" } });
        },
      ),
    );

    // The composed chain's out-context is the LAST middleware's.
    expectTypeOf(chain).toEqualTypeOf<
      ActivityMiddleware<EmptyContext, { tenantId: string; traceId: string }>
    >();
  });
});

describe("activityOptionsByName key constraint", () => {
  it("only reachable activity names (workflow-local + global) are accepted", () => {
    type Options = DeclareWorkflowOptions<typeof inferenceContract, "orderWorkflow">;

    const good: Options["activityOptionsByName"] = {
      validateOrder: { startToCloseTimeout: "1 minute" },
      log: { startToCloseTimeout: "30 seconds" },
    };
    const bad: Options["activityOptionsByName"] = {
      // @ts-expect-error — "nope" is not an activity reachable from orderWorkflow
      nope: { startToCloseTimeout: "1 minute" },
    };
    void good;
    void bad;
    expect(true).toBe(true);
  });
});

describe("continueAsNew typing", () => {
  it("types same-workflow and cross-contract dispatch, returning Promise<never>", () => {
    const roll = (context: WorkflowContext<typeof inferenceContract, "orderWorkflow">) => {
      // Same-workflow: args typed against THIS workflow's input.
      const same = context.continueAsNew({ id: "next-run" });
      expectTypeOf(same).toEqualTypeOf<Promise<never>>();

      // Cross-contract: args typed against the DESTINATION workflow's input.
      const cross = context.continueAsNew(inferenceContract, "otherWorkflow", {
        batchId: "B-2",
      });
      expectTypeOf(cross).toEqualTypeOf<Promise<never>>();

      // @ts-expect-error — wrong args shape for the same-workflow overload
      void context.continueAsNew({ wrong: true });

      // @ts-expect-error — cross-contract args must match the destination's input
      void context.continueAsNew(inferenceContract, "otherWorkflow", { id: "x" });

      return [same, cross];
    };
    void roll;
    expect(typeof roll).toBe("function");
  });
});

describe("TypedChildWorkflowOptions requires an explicit parentClosePolicy", () => {
  type ChildOptions = TypedChildWorkflowOptions<typeof inferenceContract, "otherWorkflow">;

  it("accepts each of the three real policies", () => {
    const terminate: ChildOptions["parentClosePolicy"] = "TERMINATE";
    const abandon: ChildOptions["parentClosePolicy"] = "ABANDON";
    const requestCancel: ChildOptions["parentClosePolicy"] = "REQUEST_CANCEL";
    expect([terminate, abandon, requestCancel]).toHaveLength(3);
  });

  it("rejects omission", () => {
    // @ts-expect-error parentClosePolicy is required
    const options: ChildOptions = { workflowId: "child-1", args: { batchId: "B-1" } };
    expect(options).toBeDefined();
  });

  it("rejects an explicit undefined", () => {
    // This is the test that fails if `Exclude<..., undefined>` is dropped: the
    // SDK's ParentClosePolicy union CONTAINS undefined, so a bare required
    // field would accept this and the component would be a silent no-op.
    const options: ChildOptions = {
      workflowId: "child-1",
      args: { batchId: "B-1" },
      // @ts-expect-error parentClosePolicy may not be undefined
      parentClosePolicy: undefined,
    };
    expect(options).toBeDefined();
  });
});
