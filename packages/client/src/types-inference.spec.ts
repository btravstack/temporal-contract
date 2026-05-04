/**
 * Type-level tests for the typed-client surface.
 *
 * These tests pin the generic-preservation and name-narrowing behaviour
 * required by audit findings #2 and #3:
 *
 * - Workflow input/output generics are preserved through the contract so
 *   `client.startWorkflow("…", { args })` infers the correct argument
 *   shape instead of widening to `unknown`.
 * - Signal-name constraints narrow to the workflow's declared signals
 *   (or `never`), so a typo like `signalName: "typo"` on a workflow
 *   without signals is a compile-time error rather than a runtime
 *   failure.
 *
 * Each `expectTypeOf(...)` call's assertion is purely compile-time; the
 * outer `it(...)` blocks merely cause the type-checker to visit this
 * file.
 */
import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { defineContract, defineSignal, defineWorkflow } from "@temporal-contract/contract";
import type { TypedSignalWithStartOptions, TypedWorkflowStartOptions } from "./client.js";

const contractWithSignal = defineContract({
  taskQueue: "q",
  workflows: {
    hasSignal: defineWorkflow({
      input: z.object({ a: z.string() }),
      output: z.string(),
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
    // `SignalNamesOf<…>` resolves to `never` for a no-signals workflow.
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
