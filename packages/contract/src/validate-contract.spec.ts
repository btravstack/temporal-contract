/**
 * Type-level tests. Failures here surface as `tsc --noEmit` errors, not as
 * runtime failures, so these guard the type machinery against regression.
 *
 * Vitest's `expectTypeOf` is a value at runtime but its assertion is purely
 * compile-time; we still wrap each one in `it(...)` so the type-checker visits
 * this file under the unit project.
 */
import { describe, expectTypeOf, it } from "vitest";

import type {
  CheckDuration,
  CheckName,
  CollidingActivityNames,
  IsMsDuration,
  WorkflowActivityNameClashes,
} from "./validate-contract.js";

/**
 * Invariant type equality. Unlike `extends`, this does not accept a subtype,
 * so a widened or `never` result fails instead of silently passing.
 */
type TypeEq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe("IsMsDuration", () => {
  it("accepts the grammar the runtime regex accepts", () => {
    expectTypeOf<TypeEq<IsMsDuration<"30s">, true>>().toEqualTypeOf<true>();
    expectTypeOf<TypeEq<IsMsDuration<"5 minutes">, true>>().toEqualTypeOf<true>();
    expectTypeOf<TypeEq<IsMsDuration<"1.5h">, true>>().toEqualTypeOf<true>();
    expectTypeOf<TypeEq<IsMsDuration<"1500">, true>>().toEqualTypeOf<true>();
    expectTypeOf<TypeEq<IsMsDuration<"10 seconds">, true>>().toEqualTypeOf<true>();
    expectTypeOf<TypeEq<IsMsDuration<"100ms">, true>>().toEqualTypeOf<true>();
    expectTypeOf<TypeEq<IsMsDuration<"2 hrs">, true>>().toEqualTypeOf<true>();
    expectTypeOf<TypeEq<IsMsDuration<".5s">, true>>().toEqualTypeOf<true>();
  });

  it("rejects a misspelled unit, which is the motivating typo", () => {
    expectTypeOf<TypeEq<IsMsDuration<"5 minutos">, false>>().toEqualTypeOf<true>();
  });

  it("rejects strings with no numeric part", () => {
    expectTypeOf<TypeEq<IsMsDuration<"abc">, false>>().toEqualTypeOf<true>();
    expectTypeOf<TypeEq<IsMsDuration<"">, false>>().toEqualTypeOf<true>();
    expectTypeOf<TypeEq<IsMsDuration<"s">, false>>().toEqualTypeOf<true>();
  });

  it("rejects trailing garbage after a valid unit", () => {
    expectTypeOf<TypeEq<IsMsDuration<"30 sss">, false>>().toEqualTypeOf<true>();
    expectTypeOf<TypeEq<IsMsDuration<"30s later">, false>>().toEqualTypeOf<true>();
  });

  it("rejects a negative duration, matching the runtime's deliberate exclusion", () => {
    // builder.ts:543-545 — the `ms` grammar allows a leading `-`, but a
    // negative Temporal timeout is never valid, so the sign is rejected.
    expectTypeOf<TypeEq<IsMsDuration<"-5s">, false>>().toEqualTypeOf<true>();
  });

  it("resolves to false for a widened string rather than accepting it", () => {
    // A non-literal `string` carries no information to validate. It must not
    // silently pass — Task 5 relies on this to keep `const` meaningful.
    expectTypeOf<TypeEq<IsMsDuration<string>, false>>().toEqualTypeOf<true>();
  });
});

describe("CheckDuration", () => {
  it("passes a valid duration through unchanged, so the intersection is a no-op", () => {
    expectTypeOf<TypeEq<CheckDuration<"30s">, "30s">>().toEqualTypeOf<true>();
  });

  it("passes numbers and undefined through — both are valid at runtime", () => {
    expectTypeOf<TypeEq<CheckDuration<5000>, 5000>>().toEqualTypeOf<true>();
    expectTypeOf<TypeEq<CheckDuration<undefined>, undefined>>().toEqualTypeOf<true>();
  });

  it("maps an invalid duration to a message naming the offending value", () => {
    type Result = CheckDuration<"5 minutos">;
    // The exact text matters: it is what the user reads in the compiler error.
    expectTypeOf<Result>().toExtend<`Invalid duration "5 minutos": ${string}`>();
    // And it must NOT be the input, or the check is a no-op.
    expectTypeOf<TypeEq<Result, "5 minutos">>().toEqualTypeOf<false>();
  });
});

describe("CheckName", () => {
  it("passes an ordinary name through unchanged", () => {
    expectTypeOf<
      TypeEq<CheckName<"processOrder", "workflow">, "processOrder">
    >().toEqualTypeOf<true>();
  });

  it("rejects the __temporal_ prefix for every handler kind", () => {
    type W = CheckName<"__temporal_evil", "workflow">;
    type S = CheckName<"__temporal_evil", "signal">;
    expectTypeOf<TypeEq<W, "__temporal_evil">>().toEqualTypeOf<false>();
    expectTypeOf<TypeEq<S, "__temporal_evil">>().toEqualTypeOf<false>();
    expectTypeOf<W>().toExtend<`workflow name "__temporal_evil" is reserved${string}`>();
  });

  it("rejects the two exact reserved query names", () => {
    expectTypeOf<
      TypeEq<CheckName<"__stack_trace", "query">, "__stack_trace">
    >().toEqualTypeOf<false>();
    expectTypeOf<
      TypeEq<CheckName<"__enhanced_stack_trace", "query">, "__enhanced_stack_trace">
    >().toEqualTypeOf<false>();
  });

  it("does NOT reject a lookalike that the runtime allows", () => {
    // `__temporal` without the trailing underscore is not the reserved prefix,
    // and `__stack_traces` is not one of the two exact names. The runtime
    // permits both; flagging them would be a false positive.
    expectTypeOf<TypeEq<CheckName<"__temporal", "workflow">, "__temporal">>().toEqualTypeOf<true>();
    expectTypeOf<
      TypeEq<CheckName<"__stack_traces", "query">, "__stack_traces">
    >().toEqualTypeOf<true>();
  });

  it("does NOT apply to error or search-attribute names", () => {
    // builder.ts:435-436 — these never become Temporal handler names, so the
    // runtime deliberately exempts them. The type layer must match, or valid
    // contracts stop compiling.
    expectTypeOf<
      TypeEq<CheckName<"__temporal_evil", "error">, "__temporal_evil">
    >().toEqualTypeOf<true>();
    expectTypeOf<
      TypeEq<CheckName<"__temporal_evil", "search attribute">, "__temporal_evil">
    >().toEqualTypeOf<true>();
  });

  it("leaves a non-literal key alone", () => {
    expectTypeOf<TypeEq<CheckName<string, "workflow">, string>>().toEqualTypeOf<true>();
  });
});

describe("activity collision detection", () => {
  // Two structurally DIFFERENT activity shapes. Distinct `input` types are
  // what makes them non-mutually-assignable, which is the signal the type
  // layer keys on.
  type ChargeA = { input: { amount: number }; output: { ok: boolean } };
  type ChargeB = { input: { cents: number }; output: { ok: boolean } };

  it("allows one definition shared across two workflows", () => {
    // The documented pattern: a single `defineActivity` result referenced in
    // both workflows. Same type on both sides, so nothing to flag.
    type C = {
      taskQueue: "q";
      workflows: {
        a: { input: unknown; output: unknown; activities: { charge: ChargeA } };
        b: { input: unknown; output: unknown; activities: { charge: ChargeA } };
      };
    };
    expectTypeOf<TypeEq<CollidingActivityNames<C>, never>>().toEqualTypeOf<true>();
  });

  it("flags one name bound to different definitions in two workflows", () => {
    type C = {
      taskQueue: "q";
      workflows: {
        a: { input: unknown; output: unknown; activities: { charge: ChargeA } };
        b: { input: unknown; output: unknown; activities: { charge: ChargeB } };
      };
    };
    expectTypeOf<TypeEq<CollidingActivityNames<C>, "charge">>().toEqualTypeOf<true>();
  });

  it("flags a workflow-scoped activity clashing with a different global one", () => {
    type C = {
      taskQueue: "q";
      activities: { charge: ChargeA };
      workflows: { a: { input: unknown; output: unknown; activities: { charge: ChargeB } } };
    };
    expectTypeOf<TypeEq<CollidingActivityNames<C>, "charge">>().toEqualTypeOf<true>();
  });

  it("allows the hoist pattern — global and workflow scope sharing one definition", () => {
    type C = {
      taskQueue: "q";
      activities: { charge: ChargeA };
      workflows: { a: { input: unknown; output: unknown; activities: { charge: ChargeA } } };
    };
    expectTypeOf<TypeEq<CollidingActivityNames<C>, never>>().toEqualTypeOf<true>();
  });

  it("is inert on a contract with no activities", () => {
    type C = { taskQueue: "q"; workflows: { a: { input: unknown; output: unknown } } };
    expectTypeOf<TypeEq<CollidingActivityNames<C>, never>>().toEqualTypeOf<true>();
  });

  it("flags only the colliding name when other activities are fine", () => {
    type C = {
      taskQueue: "q";
      workflows: {
        a: { input: unknown; output: unknown; activities: { charge: ChargeA; log: ChargeA } };
        b: { input: unknown; output: unknown; activities: { charge: ChargeB; log: ChargeA } };
      };
    };
    expectTypeOf<TypeEq<CollidingActivityNames<C>, "charge">>().toEqualTypeOf<true>();
  });
});

describe("workflow vs global activity name clashes", () => {
  type Act = { input: unknown; output: unknown };

  it("flags a global activity sharing a workflow's name", () => {
    type C = {
      taskQueue: "q";
      activities: { processOrder: Act };
      workflows: { processOrder: { input: unknown; output: unknown } };
    };
    expectTypeOf<TypeEq<WorkflowActivityNameClashes<C>, "processOrder">>().toEqualTypeOf<true>();
  });

  it("allows distinct names", () => {
    type C = {
      taskQueue: "q";
      activities: { logEvent: Act };
      workflows: { processOrder: { input: unknown; output: unknown } };
    };
    expectTypeOf<TypeEq<WorkflowActivityNameClashes<C>, never>>().toEqualTypeOf<true>();
  });

  it("is inert when the contract declares no global activities", () => {
    type C = { taskQueue: "q"; workflows: { processOrder: { input: unknown; output: unknown } } };
    expectTypeOf<TypeEq<WorkflowActivityNameClashes<C>, never>>().toEqualTypeOf<true>();
  });
});
