/**
 * Type-level tests. Failures here surface as `tsc --noEmit` errors, not as
 * runtime failures, so these guard the type machinery against regression.
 *
 * Vitest's `expectTypeOf` is a value at runtime but its assertion is purely
 * compile-time; we still wrap each one in `it(...)` so the type-checker visits
 * this file under the unit project.
 */
import { describe, expectTypeOf, it } from "vitest";

import type { CheckDuration, IsMsDuration } from "./validate-contract.js";

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
