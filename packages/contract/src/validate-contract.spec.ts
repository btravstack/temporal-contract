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

import { defineActivity, defineContract, defineWorkflow } from "./builder.js";
import type { ContractDefinition } from "./types.js";
import type {
  CheckDuration,
  CheckName,
  CollidingActivityNames,
  IsMsDuration,
  ValidateContract,
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

  it("does NOT flag an optional activity key declared in only one scope", () => {
    // Regression: `DefinitionsFor` resolves to `never` for an optional
    // property (`ActivitiesOf<W[K]> extends Record<N, infer D>` is false for
    // `charge?:`), and `IsUnion<never>` distributes to `never`, which took
    // the `true` branch of `extends true`. A single scope can never collide
    // with itself — the `ScopesDeclaring` gate must suppress this.
    type C = {
      taskQueue: "q";
      workflows: { a: { input: unknown; output: unknown; activities: { charge?: ChargeA } } };
    };
    expectTypeOf<TypeEq<CollidingActivityNames<C>, never>>().toEqualTypeOf<true>();
  });

  it("does NOT flag a single scope binding a union-typed definition", () => {
    // Regression: one workflow binding `charge` to `ChargeA | ChargeB` (e.g.
    // from a ternary at the call site) makes `DefinitionsFor` itself a
    // union, which `IsUnion` can't distinguish from two scopes disagreeing.
    // Only one scope declares the name, so the runtime never even reaches a
    // comparison (`builder.ts:811-812` finds no previous owner and stores).
    type C = {
      taskQueue: "q";
      workflows: {
        a: { input: unknown; output: unknown; activities: { charge: ChargeA | ChargeB } };
      };
    };
    expectTypeOf<TypeEq<CollidingActivityNames<C>, never>>().toEqualTypeOf<true>();
  });

  it("does NOT flag an optional activity key declared identically in two workflows", () => {
    // Regression (fix round 2): the round-1 fix guarded the outer
    // conditional with `ScopesDeclaring`, but `DefinitionsFor`'s inner
    // extraction (`A extends Record<N, infer D> ? D : never`) still went
    // `never` for an optional key in *every* declaring scope, which put the
    // same never-takes-the-true-branch trap one level deeper. Two workflows
    // both declaring `charge?:` must not collide with each other.
    type C = {
      taskQueue: "q";
      workflows: {
        a: { input: unknown; output: unknown; activities: { charge?: ChargeA } };
        b: { input: unknown; output: unknown; activities: { charge?: ChargeA } };
      };
    };
    expectTypeOf<TypeEq<CollidingActivityNames<C>, never>>().toEqualTypeOf<true>();
  });

  it("does NOT flag the hoist pattern when the shared key is optional", () => {
    // Regression (fix round 2): same root cause as above, exercised through
    // the documented hoist pattern (global + one workflow) instead of two
    // workflows.
    type C = {
      taskQueue: "q";
      activities: { charge?: ChargeA };
      workflows: { a: { input: unknown; output: unknown; activities: { charge?: ChargeA } } };
    };
    expectTypeOf<TypeEq<CollidingActivityNames<C>, never>>().toEqualTypeOf<true>();
  });

  it("does NOT flag a contract with no activities, even when workflows fall back to the default activities type", () => {
    // Regression (fix round 2): `WorkflowDefinition["activities"]` defaults
    // to `Record<string, never>` (`types.ts:189`) when a workflow declares
    // no activities. `keyof Record<string, never>` is `string`, so
    // `AllActivityNames` picks up the *type* `string` as a name candidate on
    // a contract that declares no activities at all. Two workflows both
    // falling back to that default must not "collide" on it.
    type C = {
      taskQueue: "q";
      workflows: {
        a: { input: unknown; output: unknown; activities: Record<string, never> };
        b: { input: unknown; output: unknown; activities: Record<string, never> };
      };
    };
    expectTypeOf<TypeEq<CollidingActivityNames<C>, never>>().toEqualTypeOf<true>();
  });

  it("does NOT flag two scopes binding the SAME union-typed definition", () => {
    // Regression (fix round 2): this is the shared-`defineActivity`-result
    // pattern (`builder.ts:816`) where the shared value itself happens to be
    // a union type, e.g. `const charge = isProd ? chargeA : chargeB`. Before
    // `DefinitionsFor` tuple-wrapped each scope's contribution, a union
    // *within* one scope's binding was indistinguishable from *disagreement
    // between* scopes: both looked like a multi-member union to `IsUnion`.
    // The runtime accepts this unconditionally (same object reference in
    // both scopes), so the type layer must too.
    type Charge = ChargeA | ChargeB;
    type C = {
      taskQueue: "q";
      workflows: {
        a: { input: unknown; output: unknown; activities: { charge: Charge } };
        b: { input: unknown; output: unknown; activities: { charge: Charge } };
      };
    };
    expectTypeOf<TypeEq<CollidingActivityNames<C>, never>>().toEqualTypeOf<true>();
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

describe("ValidateContract", () => {
  type Act = { input: unknown; output: unknown };

  it("maps a valid contract to itself, so the intersection is a no-op", () => {
    type C = {
      taskQueue: "orders";
      workflows: { processOrder: { input: unknown; output: unknown } };
    };
    // Not merely assignable — identical. If validation altered a valid
    // contract, `T & ValidateContract<T>` would reject correct code.
    expectTypeOf<TypeEq<ValidateContract<C>, C>>().toEqualTypeOf<true>();
  });

  it("replaces a reserved workflow name with a message naming it", () => {
    type C = {
      taskQueue: "orders";
      workflows: { __temporal_evil: { input: unknown; output: unknown } };
    };
    expectTypeOf<TypeEq<ValidateContract<C>, C>>().toEqualTypeOf<false>();
    // The reserved-name error lands on the remapped KEY of `workflows`, not
    // on a value — `ValidateWorkflows` uses `as CheckName<K, "workflow">` in
    // its key-remapping position. Asserting `toExtend<Record<`…${string}`,
    // unknown>>` here would be vacuous — a pattern index signature is
    // satisfied by any object type, error message or not — so pin the
    // remapped KEY SET itself instead.
    expectTypeOf<
      keyof ValidateContract<C>["workflows"]
    >().toExtend<`workflow name "__temporal_evil" is reserved${string}`>();
  });

  it("replaces a reserved global activity name", () => {
    type C = {
      taskQueue: "orders";
      workflows: { ok: { input: unknown; output: unknown } };
      activities: { __temporal_evil: Act };
    };
    expectTypeOf<TypeEq<ValidateContract<C>, C>>().toEqualTypeOf<false>();
    // Same shape as the workflow case, but on the top-level `activities` map
    // and tagged "global activity" — `ValidateActivities` remaps keys with
    // `as CheckName<K, TKind>`. Same vacuous-`Record`-target pitfall applies,
    // so pin the remapped KEY SET, not a `Record<pattern, unknown>` shape.
    expectTypeOf<
      keyof ValidateContract<C>["activities"]
    >().toExtend<`global activity name "__temporal_evil" is reserved${string}`>();
  });

  it("replaces a malformed startToCloseTimeout", () => {
    type C = {
      taskQueue: "orders";
      workflows: { ok: { input: unknown; output: unknown } };
      activities: {
        charge: {
          input: unknown;
          output: unknown;
          activityOptions: { startToCloseTimeout: "5 minutos" };
        };
      };
    };
    expectTypeOf<TypeEq<ValidateContract<C>, C>>().toEqualTypeOf<false>();
    // Duration errors land on the VALUE, not the key — `startToCloseTimeout`
    // itself is unaffected; only what it's bound to changes.
    expectTypeOf<
      ValidateContract<C>["activities"]["charge"]["activityOptions"]["startToCloseTimeout"]
    >().toExtend<`Invalid duration "5 minutos": ${string}`>();
  });

  it("replaces a malformed retry interval", () => {
    type C = {
      taskQueue: "orders";
      workflows: { ok: { input: unknown; output: unknown } };
      activities: {
        charge: {
          input: unknown;
          output: unknown;
          activityOptions: { retry: { initialInterval: "one second" } };
        };
      };
    };
    expectTypeOf<TypeEq<ValidateContract<C>, C>>().toEqualTypeOf<false>();
    expectTypeOf<
      ValidateContract<C>["activities"]["charge"]["activityOptions"]["retry"]["initialInterval"]
    >().toExtend<`Invalid duration "one second": ${string}`>();
  });

  it("leaves valid durations alone", () => {
    type C = {
      taskQueue: "orders";
      workflows: { ok: { input: unknown; output: unknown } };
      activities: {
        charge: {
          input: unknown;
          output: unknown;
          activityOptions: { startToCloseTimeout: "30s"; retry: { initialInterval: "1 minute" } };
        };
      };
    };
    expectTypeOf<TypeEq<ValidateContract<C>, C>>().toEqualTypeOf<true>();
  });

  it("flags a contract whose activity names collide", () => {
    type ChargeA = { input: { amount: number }; output: { ok: boolean } };
    type ChargeB = { input: { cents: number }; output: { ok: boolean } };
    type C = {
      taskQueue: "orders";
      workflows: {
        a: { input: unknown; output: unknown; activities: { charge: ChargeA } };
        b: { input: unknown; output: unknown; activities: { charge: ChargeB } };
      };
    };
    expectTypeOf<TypeEq<ValidateContract<C>, C>>().toEqualTypeOf<false>();
    // Cross-cutting errors are reported on the whole `workflows` property,
    // per the brief's design note — not on a key, not on a nested value.
    expectTypeOf<
      ValidateContract<C>["workflows"]
    >().toExtend<`Contract error: activity "charge" is declared with different definitions${string}`>();
  });

  it("flags a workflow name shadowed by a global activity", () => {
    type C = {
      taskQueue: "orders";
      workflows: { processOrder: { input: unknown; output: unknown } };
      activities: { processOrder: Act };
    };
    expectTypeOf<TypeEq<ValidateContract<C>, C>>().toEqualTypeOf<false>();
    // Same landing spot as the collision case — the whole `workflows`
    // property becomes the message, naming the shared identifier.
    expectTypeOf<
      ValidateContract<C>["workflows"]
    >().toExtend<`Contract error: "processOrder" is both a workflow and a global activity${string}`>();
  });

  it("does NOT flag a reserved-looking error name", () => {
    // builder.ts:435-436 — error names never become handler names.
    type C = {
      taskQueue: "orders";
      workflows: {
        ok: {
          input: unknown;
          output: unknown;
          errors: { __temporal_evil: { message: "boom" } };
        };
      };
    };
    expectTypeOf<TypeEq<ValidateContract<C>, C>>().toEqualTypeOf<true>();
  });

  it("does NOT flag a reserved-looking search attribute name", () => {
    type C = {
      taskQueue: "orders";
      workflows: {
        ok: {
          input: unknown;
          output: unknown;
          searchAttributes: { __temporal_evil: { kind: "TEXT" } };
        };
      };
    };
    expectTypeOf<TypeEq<ValidateContract<C>, C>>().toEqualTypeOf<true>();
  });

  it("is a no-op on a contract built through the real defineActivity/defineWorkflow/defineContract builders", () => {
    // Fix round 1 regression test. Every other fixture in this describe
    // block is a hand-written `type` alias, which preserves the literal
    // `"30s"`-style duration string. The real builders don't: `defineActivity`
    // infers `TActivity extends ActivityDefinition`, and
    // `ContractActivityOptions`'s duration slots are typed
    // `DurationValue = string | number` (types.ts:51, 84-89) — a union with no
    // literal member — so inference widens `startToCloseTimeout` and
    // `retry.initialInterval` to plain `string`. This is the separate-
    // `defineActivity` pattern from docs/how-to/tune-activity-options.md:44-52
    // (ship the timeout with the activity, not the workflow), and it is the
    // fixture that actually exercises that widening: `CheckDuration<string>`
    // must pass a non-literal `string` through unchanged, or every real
    // contract that sets a duration this way fails to compile.
    const charge = defineActivity({
      input: z.object({ amount: z.number() }),
      output: z.object({ ok: z.boolean() }),
      activityOptions: {
        startToCloseTimeout: "30 seconds",
        retry: { maximumAttempts: 5, initialInterval: "1 second" },
      },
    });

    const processOrder = defineWorkflow({
      input: z.object({ orderId: z.string() }),
      output: z.void(),
      activities: { charge },
    });

    const contract = defineContract({
      taskQueue: "orders",
      workflows: { processOrder },
    });

    expectTypeOf<
      TypeEq<ValidateContract<typeof contract>, typeof contract>
    >().toEqualTypeOf<true>();
  });

  it("is a no-op on the unparameterized ContractDefinition type itself", () => {
    expectTypeOf<
      TypeEq<ValidateContract<ContractDefinition>, ContractDefinition>
    >().toEqualTypeOf<true>();
  });
});
