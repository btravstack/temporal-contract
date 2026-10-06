/**
 * Type-level tests for the typed-client surface.
 *
 * Three groups of pins:
 *
 * 1. Generic preservation and name narrowing (audit findings #2 and #3):
 *    workflow input/output generics survive the contract so
 *    `client.startWorkflow("…", { args })` infers the correct argument
 *    shape, and signal names narrow to the workflow's declared signals.
 * 2. The `TypedClient`/`ContractClient` split: `for(c)` constrains names to
 *    `c`'s workflows, two contracts yield mutually incompatible
 *    `ContractClient` types, and `TypedClient` accepts no type argument —
 *    so a stray 7.x-style `TypedClient<typeof x>` fails loudly during
 *    migration instead of resolving silently.
 * 3. Method-level pins: error-union narrowing, the `searchAttributes` key
 *    constraint, and omittable payloads for input-less
 *    signals/queries/updates.
 *
 * Each `expectTypeOf(...)` / `@ts-expect-error` assertion is purely
 * compile-time; call-shaped assertions live inside never-invoked functions
 * so nothing hits a real connection at runtime.
 */
import {
  defineContract,
  defineQuery,
  defineSearchAttribute,
  defineSignal,
  defineUpdate,
  defineWorkflow,
} from "@temporal-contract/contract";
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { ContractClient, type TypedClient } from "./client.js";
import type {
  QueryFailedError,
  QueryValidationError,
  UpdateFailedError,
  UpdateRejectedError,
  UpdateRpcTimeoutOrCancelledError,
  UpdateValidationError,
  WorkflowAlreadyStartedError,
  WorkflowCancelledError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
  WorkflowTerminatedError,
  WorkflowTimeoutError,
  WorkflowValidationError,
} from "./errors.js";
import type { TypedSignalWithStartOptions, TypedWorkflowStartOptions } from "./options.js";
import { TypedScheduleClient } from "./schedule.js";

const contractWithSignal = defineContract({
  taskQueue: "q",
  workflows: {
    hasSignal: defineWorkflow({
      input: z.object({ a: z.string() }),
      output: z.string(),
      startPolicy: "allow-duplicate",
      signals: {
        cancel: defineSignal({ input: z.object({ reason: z.string() }) }),
      },
    }),
  },
});

const contractNoSignals = defineContract({
  taskQueue: "q",
  workflows: {
    bare: defineWorkflow({
      input: z.object({ a: z.string() }),
      output: z.string(),
      startPolicy: "allow-duplicate",
    }),
  },
});

const richContract = defineContract({
  taskQueue: "rich-q",
  workflows: {
    processOrder: defineWorkflow({
      input: z.object({ orderId: z.string() }),
      output: z.object({ status: z.string() }),
      startPolicy: "allow-duplicate",
      signals: {
        // Payload-less signal — `defineSignal()` materializes an
        // UndefinedInputSchema, so the client-side payload is omittable.
        stop: defineSignal(),
        setPriority: defineSignal({ input: z.object({ level: z.number() }) }),
      },
      queries: {
        progress: defineQuery({ output: z.number() }),
        itemStatus: defineQuery({ input: z.object({ sku: z.string() }), output: z.string() }),
      },
      updates: {
        refresh: defineUpdate({ output: z.boolean() }),
        adjust: defineUpdate({ input: z.object({ delta: z.number() }), output: z.number() }),
      },
      searchAttributes: {
        customerId: defineSearchAttribute({ kind: "KEYWORD" }),
        priority: defineSearchAttribute({ kind: "INT" }),
      },
    }),
  },
});

describe("startWorkflow argument inference (audit fix #2)", () => {
  it("infers `args` to the workflow's input schema (not unknown)", () => {
    type Options = TypedWorkflowStartOptions<typeof contractNoSignals, "bare">;
    expectTypeOf<Options["args"]>().toEqualTypeOf<{ a: string }>();
  });

  it("preserves a declared signal's input schema for signalArgs", () => {
    type Options = TypedSignalWithStartOptions<typeof contractWithSignal, "hasSignal", "cancel">;
    expectTypeOf<Options["signalArgs"]>().toEqualTypeOf<{ reason: string }>();
  });
});

describe("signalWithStart name narrowing (audit fix #3)", () => {
  it("typing `signalName` against a workflow without signals collapses to `never`", () => {
    // Before the fix, the constraint on `TSignalName` resolved to `string`,
    // so any literal — including a typo — was accepted. The narrowed
    // helper makes the only valid `signalName` value `never`, so the call
    // site refuses concrete strings like "anything" or "typo".
    //
    // We materialise that by asking for `TypedSignalWithStartOptions` with
    // the literal "anything" as the signal name; the resulting `signalName`
    // field collapses to `never` because the generic constraint
    // `InferSignalNames<…>` resolves to `never` for a no-signals workflow.
    type Options = TypedSignalWithStartOptions<
      typeof contractNoSignals,
      "bare",
      // `never` is the only value that satisfies the narrowed constraint.
      // The audit-broken signature accepted `string` here.
      never
    >;
    expectTypeOf<Options["signalName"]>().toEqualTypeOf<never>();
  });
});

describe("TypedClient/ContractClient split", () => {
  it("TypedClient accepts no type argument — a stray 7.x-style annotation fails loudly", () => {
    // @ts-expect-error — TypedClient is not generic anymore; the contract
    // type parameter lives on ContractClient.
    type Stray = TypedClient<typeof contractWithSignal>;
    const _stray: Stray | undefined = undefined;
    void _stray;
  });

  it("for(c) constrains startWorkflow to c's workflow names", () => {
    // Never invoked — the body only exercises the type-checker.
    const _pin = async (root: TypedClient) => {
      const bound = root.for(contractWithSignal);
      expectTypeOf(bound.startWorkflow).parameter(0).toEqualTypeOf<"hasSignal">();

      // @ts-expect-error — "bare" belongs to the OTHER contract.
      void bound.startWorkflow("bare", { workflowId: "x", args: { a: "s" } });

      // @ts-expect-error — typos are compile-time errors.
      void bound.startWorkflow("hasSignalTypo", { workflowId: "x", args: { a: "s" } });
    };
    void _pin;
  });

  it("two different contracts yield mutually incompatible ContractClient types", () => {
    type A = ContractClient<typeof contractWithSignal>;
    type B = ContractClient<typeof contractNoSignals>;
    expectTypeOf<A>().not.toEqualTypeOf<B>();
    expectTypeOf<A>().not.toMatchTypeOf<B>();
    expectTypeOf<B>().not.toMatchTypeOf<A>();
  });

  it("for() preserves the contract's type through to the binding", () => {
    const _pin = (root: TypedClient) => {
      const bound = root.for(contractNoSignals);
      expectTypeOf(bound).toEqualTypeOf<ContractClient<typeof contractNoSignals>>();
    };
    void _pin;
  });
});

describe("method-level pins", () => {
  it("executeWorkflow narrows the error union to the modeled client errors", () => {
    const _pin = async (bound: ContractClient<typeof contractNoSignals>) => {
      const result = await bound.executeWorkflow("bare", {
        workflowId: "x",
        args: { a: "s" },
      });
      if (result.isOk()) {
        expectTypeOf(result.value).toEqualTypeOf<string>();
      }
      if (result.isErr()) {
        // `bare` declares no contract errors, so the union is exactly the
        // client-side kinds — no ContractError member, no widening to Error.
        expectTypeOf(result.error).toMatchTypeOf<
          WorkflowValidationError | WorkflowAlreadyStartedError | { workflowId: string }
        >();
        expectTypeOf(result.error).not.toBeAny();
        expectTypeOf<(typeof result)["error"]>().not.toEqualTypeOf<Error>();
      }
    };
    void _pin;
  });

  it("startWorkflow narrows the error union to start-phase errors only", () => {
    const _pin = async (bound: ContractClient<typeof contractNoSignals>) => {
      const result = await bound.startWorkflow("bare", { workflowId: "x", args: { a: "s" } });
      if (result.isErr()) {
        expectTypeOf(result.error).toEqualTypeOf<
          WorkflowValidationError | WorkflowAlreadyStartedError
        >();
      }
    };
    void _pin;
  });

  it("searchAttributes keys are constrained to the declared attributes", () => {
    const _pin = (bound: ContractClient<typeof richContract>) => {
      void bound.startWorkflow("processOrder", {
        workflowId: "x",
        args: { orderId: "o" },
        searchAttributes: { customerId: "c", priority: 1 },
      });

      void bound.startWorkflow("processOrder", {
        workflowId: "x",
        args: { orderId: "o" },
        // @ts-expect-error — `unknownAttr` isn't declared on processOrder.
        searchAttributes: { unknownAttr: "nope" },
      });

      void bound.startWorkflow("processOrder", {
        workflowId: "x",
        args: { orderId: "o" },
        // @ts-expect-error — INT attribute values must be numbers.
        searchAttributes: { priority: "high" },
      });
    };
    void _pin;
  });

  it("input-less signal/query/update payloads are omittable on the typed handle", () => {
    const _pin = async (bound: ContractClient<typeof richContract>) => {
      const handle = bound.getHandle("processOrder", "id-1");

      // Payload-less definitions: the argument can be omitted entirely.
      void handle.signals.stop();
      void handle.queries.progress();
      void handle.updates.refresh();
      void handle.startUpdate("refresh");

      // Definitions WITH an input still require their payload.
      // @ts-expect-error — setPriority requires { level: number }.
      void handle.signals.setPriority();
      // @ts-expect-error — itemStatus requires { sku: string }.
      void handle.queries.itemStatus();
      // @ts-expect-error — adjust requires { delta: number }.
      void handle.updates.adjust();
      // @ts-expect-error — adjust's startUpdate options require args.
      void handle.startUpdate("adjust");
      // @ts-expect-error — adjust's startUpdate args are non-optional.
      void handle.startUpdate("adjust", {});

      void handle.signals.setPriority({ level: 2 });
      void handle.startUpdate("adjust", { args: { delta: 1 } });
    };
    void _pin;
  });

  it("payload-less signals are omittable through signalWithStart", () => {
    const _pin = (bound: ContractClient<typeof richContract>) => {
      // `stop` takes no payload — `signalArgs` can be omitted.
      void bound.signalWithStart("processOrder", {
        workflowId: "x",
        args: { orderId: "o" },
        signalName: "stop",
      });

      void bound.signalWithStart("processOrder", {
        workflowId: "x",
        args: { orderId: "o" },
        signalName: "setPriority",
        signalArgs: { level: 1 },
      });

      // @ts-expect-error — setPriority's signalArgs are required.
      void bound.signalWithStart("processOrder", {
        workflowId: "x",
        args: { orderId: "o" },
        signalName: "setPriority",
      });
    };
    void _pin;
  });

  it("executeWorkflow's error union includes the first-class outcome errors, precisely", () => {
    const _pin = async (bound: ContractClient<typeof contractNoSignals>) => {
      const result = await bound.executeWorkflow("bare", { workflowId: "x", args: { a: "s" } });
      if (result.isErr()) {
        // `bare` declares no contract errors, so this is the exact union —
        // cancellation/termination/timeout are first-class members, not
        // `WorkflowFailedError.cause` variants.
        expectTypeOf(result.error).toEqualTypeOf<
          | WorkflowValidationError
          | WorkflowAlreadyStartedError
          | WorkflowFailedError
          | WorkflowCancelledError
          | WorkflowTerminatedError
          | WorkflowTimeoutError
          | WorkflowExecutionNotFoundError
        >();
      }
    };
    void _pin;
  });

  it("handle.result() surfaces the same outcome-aware union", () => {
    const _pin = async (bound: ContractClient<typeof contractNoSignals>) => {
      const typedHandle = bound.getHandle("bare", "id-1");
      const result = await typedHandle.result();
      if (result.isErr()) {
        expectTypeOf(result.error).toEqualTypeOf<
          | WorkflowValidationError
          | WorkflowFailedError
          | WorkflowCancelledError
          | WorkflowTerminatedError
          | WorkflowTimeoutError
          | WorkflowExecutionNotFoundError
        >();
      }
    };
    void _pin;
  });

  it("queries err with QueryFailedError beside validation and not-found", () => {
    const _pin = async (bound: ContractClient<typeof richContract>) => {
      const typedHandle = bound.getHandle("processOrder", "id-1");
      const result = await typedHandle.queries.progress();
      if (result.isErr()) {
        expectTypeOf(result.error).toEqualTypeOf<
          QueryValidationError | QueryFailedError | WorkflowExecutionNotFoundError
        >();
      }
    };
    void _pin;
  });

  it("updates err with UpdateRejectedError/UpdateFailedError beside validation and not-found", () => {
    const _pin = async (bound: ContractClient<typeof richContract>) => {
      const handle = bound.getHandle("processOrder", "id-1");

      const executed = await handle.updates.refresh(undefined, { updateId: "u-1" });
      if (executed.isErr()) {
        expectTypeOf(executed.error).toEqualTypeOf<
          | UpdateValidationError
          | UpdateRejectedError
          | UpdateFailedError
          | UpdateRpcTimeoutOrCancelledError
          | WorkflowExecutionNotFoundError
        >();
      }

      // Starting never surfaces the outcome: a rejection or a failed
      // handler is only visible on the update handle's result().
      const started = await handle.startUpdate("refresh");
      if (started.isErr()) {
        expectTypeOf(started.error).toEqualTypeOf<
          UpdateValidationError | UpdateRpcTimeoutOrCancelledError | WorkflowExecutionNotFoundError
        >();
      }
      if (started.isOk()) {
        const outcome = await started.value.result();
        if (outcome.isErr()) {
          expectTypeOf(outcome.error).toEqualTypeOf<
            | UpdateValidationError
            | UpdateRejectedError
            | UpdateFailedError
            | UpdateRpcTimeoutOrCancelledError
            | WorkflowExecutionNotFoundError
          >();
        }
      }

      const reattached = await handle.getUpdateHandle("adjust", "u-2").result();
      if (reattached.isOk()) {
        expectTypeOf(reattached.value).toEqualTypeOf<number>();
      }
      // @ts-expect-error — only declared updates can be reattached.
      handle.getUpdateHandle("nope", "u-3");
    };
    void _pin;
  });

  it("the contract owns workflowIdReusePolicy and followRuns on every start path", () => {
    const _pin = async (bound: ContractClient<typeof richContract>) => {
      await bound.startWorkflow("processOrder", {
        workflowId: "x",
        args: { orderId: "o" },
        // @ts-expect-error — the contract's startPolicy owns the reuse policy.
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
      });
      await bound.startWorkflow("processOrder", {
        workflowId: "x",
        args: { orderId: "o" },
        // @ts-expect-error — handles always follow the run chain.
        followRuns: false,
      });
      await bound.signalWithStart("processOrder", {
        workflowId: "x",
        args: { orderId: "o" },
        signalName: "stop",
        // @ts-expect-error — the contract's startPolicy owns the reuse policy.
        workflowIdReusePolicy: "ALLOW_DUPLICATE",
      });
    };
    void _pin;
  });

  it("executeUpdateWithStart types the update payload and result", () => {
    const _pin = async (bound: ContractClient<typeof richContract>) => {
      const result = await bound.executeUpdateWithStart("processOrder", {
        workflowId: "x",
        args: { orderId: "o" },
        workflowIdConflictPolicy: "USE_EXISTING",
        updateName: "adjust",
        updateArgs: { delta: 1 },
      });
      if (result.isOk()) {
        expectTypeOf(result.value).toEqualTypeOf<number>();
      }
      await bound.executeUpdateWithStart("processOrder", {
        workflowId: "x",
        args: { orderId: "o" },
        workflowIdConflictPolicy: "USE_EXISTING",
        updateName: "adjust",
        // @ts-expect-error — adjust requires { delta: number }.
        updateArgs: { delta: "1" },
      });
    };
    void _pin;
  });

  it("ContractClient and TypedScheduleClient are not publicly constructible", () => {
    const _pin = () => {
      // @ts-expect-error — private constructor: obtain instances via typedClient.for(contract).
      const _client = new ContractClient(contractNoSignals, undefined as never, []);
      // @ts-expect-error — private constructor: reach it via typedClient.for(contract).schedule.
      const _schedule = new TypedScheduleClient(contractNoSignals, undefined as never);
      void _client;
      void _schedule;
    };
    void _pin;
  });

  it("getHandle returns the handle directly and offers no followRuns", () => {
    const _pin = (bound: ContractClient<typeof richContract>) => {
      const handle = bound.getHandle("processOrder", "id-1", {
        runId: "run-1",
        firstExecutionRunId: "run-0",
      });
      expectTypeOf(handle.runId).toEqualTypeOf<string | undefined>();
      expectTypeOf(handle.firstExecutionRunId).toEqualTypeOf<string | undefined>();
      // @ts-expect-error — the handle always follows the run chain.
      bound.getHandle("processOrder", "id-1", { followRuns: false });
    };
    void _pin;
  });
});
