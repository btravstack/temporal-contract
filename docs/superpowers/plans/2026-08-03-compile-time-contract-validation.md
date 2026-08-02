# Compile-time Contract Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn three `defineContract` runtime validations — Temporal-reserved names, the `ms` duration grammar, and flat-namespace activity collisions — into compile errors that carry their guidance in the error message, without removing any runtime check.

**Architecture:** A new `packages/contract/src/validate-contract.ts` exports `ValidateContract<T>`, a mapped type that leaves valid contracts structurally unchanged and replaces each offending property with a **string-literal error type** whose text is the diagnostic. `defineContract`'s signature becomes `<const T extends ContractDefinition>(definition: T & ValidateContract<T>): T`. The `const` modifier is what keeps duration string literals from widening to `string`; without it the duration check silently never fires.

**Tech Stack:** TypeScript 6.0.3 (template literal types, `const` type parameters, mapped types), Vitest 4.1.10 (`expectTypeOf`, `@ts-expect-error`), pnpm workspaces + turbo, oxlint.

**Spec:** `docs/superpowers/specs/2026-08-03-compile-time-contract-validation-design.md`

## Global Constraints

- **No `any`.** Use `unknown` and narrow. Enforced by oxlint. This includes type-level code — use `unknown` in constraint positions.
- **`.js` extensions in every import.** `./validate-contract.js`, never `./validate-contract` or `./validate-contract.ts`.
- **ESM only.** All packages are `"type": "module"`.
- **Never edit per-package `package.json` dependency versions** — the `catalog:` block in `pnpm-workspace.yaml` is the only place versions are bumped. This plan adds no dependencies.
- **Every runtime `fail()` site stays.** All 31 remain exactly as they are. This work _adds_ a compile-time layer and removes nothing. A task that deletes or weakens a runtime check has failed.
- **Error types are string literals carrying their message, never `never`.** `never` produces "not assignable to type 'never'", which is strictly worse than the runtime error it shadows. A bare `never` in an error position is a defect.
- **The type layer must mirror the runtime layer, never exceed it.** Where the two can diverge, the type layer must be the _permissive_ one. A compile error on a contract the runtime accepts is a false positive that breaks valid user code — worse than the gap it closes.
- **Reserved names apply to exactly six kinds:** workflow, activity, global activity, signal, query, update. **Error names and search-attribute names are deliberately excluded** (`builder.ts:435-436`) — they never become Temporal handler names.
- Conventional Commits are enforced by commitlint on a git hook. Use `feat:`, `test:`, `docs:`, `refactor:`.

---

## File Structure

| File                                              | Responsibility                                                                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/contract/src/validate-contract.ts`      | **Create.** All type-level validation: duration grammar, reserved names, collisions, and the `ValidateContract<T>` entry point. Not exported from the package's public entry — internal to `defineContract`'s signature. |
| `packages/contract/src/validate-contract.spec.ts` | **Create.** Type-level tests, following the existing `types-inference.spec.ts` convention.                                                                                                                               |
| `packages/contract/src/builder.ts`                | **Modify.** Line 359-361 signature only. The runtime body is untouched.                                                                                                                                                  |
| `packages/contract/src/builder.spec.ts`           | **Modify** (Task 6 only, if `const` requires it). Existing runtime tests.                                                                                                                                                |

## Sequencing rationale

Tasks 1-3 build and test each validator **in isolation against local fixture types**, with no dependency on `defineContract`. They are pure type-level units, each independently reviewable.

Task 4 composes them into `ValidateContract<T>`. Task 5 wires it into `defineContract` and adds `const` — this is the first task that can break the rest of the repo, and it is deliberately late so that failures have exactly one cause. Task 6 handles fallout and measures compile cost.

---

## A note on testing type-level code

**Read this before Task 1.** Type-level tests fail in ways runtime tests cannot, and this project has repeatedly shipped guards that passed vacuously.

Two things make a type-level assertion real:

1. **The file must actually be type-checked.** `expectTypeOf`'s assertion is compile-time only; the existing convention wraps it in `it(...)` so the type-checker visits the file under the unit project (see the header comment of `packages/contract/src/types-inference.spec.ts`). A type-test file `tsc` never visits passes unconditionally.

2. **The assertion must be able to fail.** `const x: SomeType = [] as never` typechecks against _anything_ and proves nothing. Use the strict-equality helper below, which compares types invariantly, and prove it discriminates with a positive control.

This helper is used throughout the plan:

```ts
/**
 * Invariant type equality. The two-function-signature trick compares types
 * exactly — unlike `extends`, it does not accept a subtype, so
 * `TypeEq<string, "a">` is `false`.
 */
type TypeEq<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
```

Every task below ends by running `tsc` and checking the **exact error count and line numbers**, not merely "it compiled" or "it errored".

---

### Task 1: The `ms` duration grammar as a type

**Files:**

- Create: `packages/contract/src/validate-contract.ts`
- Create: `packages/contract/src/validate-contract.spec.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `type IsMsDuration<S extends string> = true | false`
  - `type CheckDuration<V> = V` when valid, or a string-literal error message when not. Accepts `unknown`, so it also passes through numbers and `undefined` untouched.

**Background.** The runtime grammar lives at `packages/contract/src/builder.ts:547-548`:

```ts
const MS_DURATION_PATTERN =
  /^(?:\d+)?\.?\d+ *(?:milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i;
```

Numbers are also valid durations (non-negative finite milliseconds), and `undefined` means absent. The type only checks **string** values; numbers and `undefined` pass through.

**The trap.** The obvious formulation — matching `` `${infer N}${Unit}` `` — is wrong. Unit suffixes are suffixes of each other (`"s"` vs `"seconds"`), so inference splits `"5 minutes"` at the wrong point and silently rejects a valid duration. Consume the numeric run **left to right** instead.

- [ ] **Step 1: Write the failing test**

Create `packages/contract/src/validate-contract.spec.ts`:

```ts
/**
 * Type-level tests. Failures here surface as `tsc --noEmit` errors, not as
 * runtime failures, so these guard the type machinery against regression.
 *
 * Vitest's `expectTypeOf` is a value at runtime but its assertion is purely
 * compile-time; we still wrap each one in `it(...)` so the type-checker visits
 * this file under the unit project.
 */
import { describe, expectTypeOf, it } from "vitest";

import type { IsMsDuration } from "./validate-contract.js";

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
```

- [ ] **Step 2: Run it and verify it fails for the right reason**

```bash
pnpm --filter @temporal-contract/contract typecheck
```

Expected: errors reporting `Cannot find module './validate-contract.js'`. If you see any _other_ error, stop and investigate — the test file itself is wrong.

- [ ] **Step 3: Implement the duration grammar**

Create `packages/contract/src/validate-contract.ts`:

```ts
/**
 * Compile-time mirror of `defineContract`'s runtime validations.
 *
 * Every type here has a counterpart in `builder.ts`, and the runtime check is
 * authoritative: these types exist to move a subset of those failures from
 * `defineContract` call time to `tsc` time. Where the two layers can diverge,
 * this layer is deliberately the more permissive one — a compile error on a
 * contract the runtime would accept is a false positive that breaks valid user
 * code, which is worse than the gap it closes.
 */

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

/**
 * The unit suffixes of the `ms` grammar (`builder.ts:547-548`), lowercase.
 * Matching is case-insensitive, handled by `Lowercase<S>` at the entry point.
 */
type MsUnit =
  | "milliseconds"
  | "millisecond"
  | "msecs"
  | "msec"
  | "ms"
  | "seconds"
  | "second"
  | "secs"
  | "sec"
  | "s"
  | "minutes"
  | "minute"
  | "mins"
  | "min"
  | "m"
  | "hours"
  | "hour"
  | "hrs"
  | "hr"
  | "h"
  | "days"
  | "day"
  | "d"
  | "weeks"
  | "week"
  | "w"
  | "years"
  | "year"
  | "yrs"
  | "yr"
  | "y";

/**
 * Consume the leading run of digits and dots, returning `[consumed, rest]`.
 *
 * Parsing left-to-right is load-bearing. Splitting on the unit instead —
 * `S extends `${infer N}${MsUnit}`` — silently rejects "5 minutes", because
 * "s" is itself a unit and a suffix of "seconds", so inference picks the
 * wrong split point.
 */
type SplitNumber<S extends string, Acc extends string = ""> = S extends `${infer C}${infer Rest}`
  ? C extends Digit | "."
    ? SplitNumber<Rest, `${Acc}${C}`>
    : [Acc, S]
  : [Acc, S];

/** Drop the optional spaces the `ms` grammar allows between number and unit. */
type TrimLeft<S extends string> = S extends ` ${infer Rest}` ? TrimLeft<Rest> : S;

/**
 * Does the consumed run parse as a number? `${number}` rejects "" and "." and
 * "1.2.3" — exactly the cases the runtime regex rejects.
 */
type IsNumeric<S extends string> = S extends `${number}` ? true : false;

/**
 * Compile-time equivalent of `MS_DURATION_PATTERN.test(value)`.
 *
 * `false` for a non-literal `string`: there is nothing to validate, and
 * accepting it would make the check vacuous wherever inference widens.
 */
export type IsMsDuration<S extends string> = string extends S
  ? false
  : SplitNumber<Lowercase<S>> extends [infer N extends string, infer Rest extends string]
    ? IsNumeric<N> extends true
      ? TrimLeft<Rest> extends ""
        ? true
        : TrimLeft<Rest> extends MsUnit
          ? true
          : false
      : false
    : false;
```

- [ ] **Step 4: Run the type tests and verify they pass**

```bash
pnpm --filter @temporal-contract/contract typecheck
```

Expected: **zero errors.**

- [ ] **Step 5: Prove the tests can fail (positive control)**

This step is mandatory. Temporarily append to `validate-contract.spec.ts`:

```ts
// POSITIVE CONTROL — delete before committing.
type ControlCheck = TypeEq<IsMsDuration<"5 minutos">, true>;
const control: ControlCheck = true;
```

Run `tsc` again. Expected: **exactly one error**, `Type 'true' is not assignable to type 'false'`, on the `const control` line.

If it does _not_ error, the test file is not being type-checked and every assertion in it is worthless — stop and fix that before continuing.

Then delete the control block and re-run to confirm zero errors.

- [ ] **Step 6: Add the value-level entry point**

Append to `validate-contract.ts`:

```ts
/**
 * Validate one duration slot, passing valid values through unchanged.
 *
 * Numbers and `undefined` pass through: the runtime accepts a non-negative
 * finite number of milliseconds, and every duration slot is optional. Only
 * string literals are checked. A valid value maps to itself so the
 * intersection in `ValidateContract` is a no-op; an invalid one maps to a
 * string literal whose text is the diagnostic, which is what the user sees in
 * the "not assignable to" error.
 */
export type CheckDuration<V> = V extends string
  ? IsMsDuration<V> extends true
    ? V
    : `Invalid duration "${V}": expected an ms-formatted string — a number followed by an optional unit ms/s/m/h/d/w/y or its long form, e.g. "30s", "5 minutes", "1.5h" — or a number of milliseconds`
  : V;
```

- [ ] **Step 7: Test the entry point**

Append to `validate-contract.spec.ts` (add `CheckDuration` to the existing type import):

```ts
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
```

- [ ] **Step 8: Verify and commit**

```bash
pnpm --filter @temporal-contract/contract typecheck
pnpm --filter @temporal-contract/contract test
pnpm lint
```

Expected: zero type errors, tests pass, lint clean.

```bash
git add packages/contract/src/validate-contract.ts packages/contract/src/validate-contract.spec.ts
git commit -m "feat(contract): add compile-time ms duration grammar"
```

---

### Task 2: Reserved Temporal names as a type

**Files:**

- Modify: `packages/contract/src/validate-contract.ts`
- Modify: `packages/contract/src/validate-contract.spec.ts`

**Interfaces:**

- Consumes: nothing from Task 1 — this is an independent type in the same file.
- Produces: `type CheckName<K, TKind extends string> = K` when allowed, or a string-literal error message when reserved.

**Background.** The runtime rule is `assertIdentifier` at `builder.ts:496-508`:

```ts
const TEMPORAL_RESERVED_PREFIX = "__temporal_";
const TEMPORAL_RESERVED_NAMES: readonly string[] = ["__stack_trace", "__enhanced_stack_trace"];
```

**This applies to exactly six kinds** (`TEMPORAL_NAMED_KINDS`, `builder.ts:442-449`): `workflow`, `activity`, `global activity`, `signal`, `query`, `update`.

Error names and search-attribute names are **excluded on purpose** — `builder.ts:435-436` states they never become Temporal handler names. Rejecting them at compile time would break valid contracts. The kind-awareness is not decoration; it is the correctness requirement.

This task does **not** implement the `IDENTIFIER_PATTERN` check — that is out of scope per the spec.

- [ ] **Step 1: Write the failing test**

Append to `packages/contract/src/validate-contract.spec.ts` (add `CheckName` to the type import):

```ts
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
```

- [ ] **Step 2: Run and verify it fails**

```bash
pnpm --filter @temporal-contract/contract typecheck
```

Expected: errors reporting that `CheckName` is not exported from `./validate-contract.js`.

- [ ] **Step 3: Implement**

Append to `packages/contract/src/validate-contract.ts`:

```ts
/**
 * The kinds whose names become Temporal handler names, mirroring
 * `TEMPORAL_NAMED_KINDS` (`builder.ts:442-449`).
 *
 * `error` and `search attribute` are absent on purpose: `builder.ts:435-436`
 * documents that those names never reach the SDK's handler registry, so the
 * runtime exempts them. Adding them here would reject contracts that are
 * valid today.
 */
type TemporalNamedKind =
  "workflow" | "activity" | "global activity" | "signal" | "query" | "update";

/** The two exact query names Temporal registers for stack-trace introspection. */
type TemporalReservedName = "__stack_trace" | "__enhanced_stack_trace";

/**
 * Compile-time mirror of the reserved-name half of `assertIdentifier`
 * (`builder.ts:500-507`). Valid names pass through unchanged; a reserved name
 * maps to a string literal whose text is the diagnostic.
 *
 * `TKind` is deliberately `string` rather than `TemporalNamedKind` so callers
 * can pass any kind label — non-handler kinds simply fall through the first
 * conditional and are never checked.
 */
export type CheckName<K, TKind extends string> = TKind extends TemporalNamedKind
  ? K extends string
    ? string extends K
      ? K
      : K extends `__temporal_${string}`
        ? `${TKind} name "${K}" is reserved by Temporal — names starting with "__temporal_" are used internally by the Temporal SDK. Rename it.`
        : K extends TemporalReservedName
          ? `${TKind} name "${K}" is reserved by Temporal — "__stack_trace" and "__enhanced_stack_trace" are used internally by the Temporal SDK. Rename it.`
          : K
    : K
  : K;
```

- [ ] **Step 4: Verify the tests pass**

```bash
pnpm --filter @temporal-contract/contract typecheck
```

Expected: **zero errors.**

- [ ] **Step 5: Positive control**

Temporarily append to the spec file:

```ts
// POSITIVE CONTROL — delete before committing.
const nameControl: TypeEq<CheckName<"__temporal_evil", "workflow">, "__temporal_evil"> = true;
```

Run `tsc`. Expected: **exactly one error** on that line. Delete the block and re-run to confirm zero.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @temporal-contract/contract test
pnpm lint
git add packages/contract/src/validate-contract.ts packages/contract/src/validate-contract.spec.ts
git commit -m "feat(contract): add compile-time reserved-name check"
```

---

### Task 3: Activity-name collisions as a type

**Files:**

- Modify: `packages/contract/src/validate-contract.ts`
- Modify: `packages/contract/src/validate-contract.spec.ts`

**Interfaces:**

- Consumes: nothing from Tasks 1-2.
- Produces:
  - `type CollidingActivityNames<C>` — union of activity names bound to structurally different definitions.
  - `type WorkflowActivityNameClashes<C>` — union of names used by both a workflow and a global activity.

**Background — read carefully, this task has the subtlest requirement in the plan.**

The runtime has two cross-cutting checks in `validateNameCollisions` (`builder.ts:775-831`):

1. **Workflow name vs global activity name** (`builder.ts:779-787`). Pure name clash, no escape hatch. Lifts exactly.

2. **Activity names across scopes** (`builder.ts:810-829`). Activities share one flat runtime namespace, so a duplicate name clobbers. **But there is an escape hatch at `builder.ts:816`:**

```ts
if (previousOwner.definition === definition) {
  // Same definition object in both scopes — the flat namespace stays
  // unambiguous, so sharing one `defineActivity` result is allowed.
  continue;
}
```

That is **reference identity**, which the type system cannot observe. So the type-level rule is **structural**: flag a name only when the definitions bound to it are not mutually assignable.

The consequence, which is intended and must not be "fixed": two **structurally identical but referentially distinct** definitions pass the type check and still fail at runtime. The type layer is permissive; the runtime check remains authoritative. Tightening this would produce false positives on the documented shared-`defineActivity` pattern.

- [ ] **Step 1: Write the failing test**

Append to `packages/contract/src/validate-contract.spec.ts` (add both new types to the import):

```ts
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
```

- [ ] **Step 2: Run and verify it fails**

```bash
pnpm --filter @temporal-contract/contract typecheck
```

Expected: errors reporting the two new types are not exported.

- [ ] **Step 3: Implement**

Append to `packages/contract/src/validate-contract.ts`:

```ts
/** A contract shape loose enough to inspect before it is known to be valid. */
type ContractLike = {
  workflows?: unknown;
  activities?: unknown;
};

/** The `activities` map of one workflow, or `{}` when the slot is absent. */
type ActivitiesOf<W> = W extends { activities: infer A } ? A : Record<never, never>;

/** The global `activities` map, or `{}` when the slot is absent. */
type GlobalActivitiesOf<C> = C extends { activities: infer A } ? A : Record<never, never>;

/** Every activity name declared anywhere in the contract. */
type AllActivityNames<C extends ContractLike> =
  | keyof GlobalActivitiesOf<C>
  | (C extends { workflows: infer W }
      ? { [K in keyof W]: keyof ActivitiesOf<W[K]> }[keyof W]
      : never);

/**
 * Every definition bound to activity name `N`, as a union. One member means
 * one shape; more than one means the scopes disagree.
 */
type DefinitionsFor<C extends ContractLike, N extends PropertyKey> =
  | (GlobalActivitiesOf<C> extends Record<N, infer D> ? D : never)
  | (C extends { workflows: infer W }
      ? { [K in keyof W]: ActivitiesOf<W[K]> extends Record<N, infer D> ? D : never }[keyof W]
      : never);

/**
 * Is `T` a union of more than one member? A single-member union satisfies
 * `[U] extends [T]` on its own distribution; a wider one does not.
 */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * Activity names bound to structurally different definitions.
 *
 * This is a deliberate approximation of the runtime rule. `builder.ts:816`
 * permits a duplicate name when both scopes reference the *same object*, and
 * reference identity is invisible to the type system — so the comparison here
 * is structural instead. Two structurally identical but referentially distinct
 * definitions therefore pass this check and are still rejected at runtime.
 *
 * That asymmetry is intended: the type layer must never be stricter than the
 * runtime, or the documented pattern of sharing one `defineActivity` result
 * across scopes would stop compiling.
 */
export type CollidingActivityNames<C extends ContractLike> = {
  [N in AllActivityNames<C>]: IsUnion<DefinitionsFor<C, N>> extends true ? N : never;
}[AllActivityNames<C>];

/**
 * Names used by both a workflow and a global activity. Mirrors
 * `builder.ts:779-787`: workflow implementations and global activity
 * implementations share the root of the worker's implementations map, so a
 * shared name is ambiguous. No escape hatch — this lifts exactly.
 */
export type WorkflowActivityNameClashes<C extends ContractLike> = C extends {
  workflows: infer W;
}
  ? Extract<keyof GlobalActivitiesOf<C>, keyof W>
  : never;
```

- [ ] **Step 4: Verify the tests pass**

```bash
pnpm --filter @temporal-contract/contract typecheck
```

Expected: **zero errors.**

- [ ] **Step 5: Positive control on the subtlest case**

The escape-hatch case is the one most likely to silently invert. Temporarily append:

```ts
// POSITIVE CONTROL — delete before committing.
type _CtlA = { input: { amount: number }; output: { ok: boolean } };
type _CtlContract = {
  taskQueue: "q";
  workflows: {
    a: { input: unknown; output: unknown; activities: { charge: _CtlA } };
    b: { input: unknown; output: unknown; activities: { charge: _CtlA } };
  };
};
const collisionControl: TypeEq<CollidingActivityNames<_CtlContract>, "charge"> = true;
```

Run `tsc`. Expected: **exactly one error** on the `collisionControl` line, proving the shared-definition case genuinely resolves to `never` rather than the assertion passing vacuously. Delete the block and re-run to confirm zero.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @temporal-contract/contract test
pnpm lint
git add packages/contract/src/validate-contract.ts packages/contract/src/validate-contract.spec.ts
git commit -m "feat(contract): add compile-time activity collision detection"
```

---

### Task 4: Compose `ValidateContract<T>`

**Files:**

- Modify: `packages/contract/src/validate-contract.ts`
- Modify: `packages/contract/src/validate-contract.spec.ts`

**Interfaces:**

- Consumes: `CheckDuration<V>` (Task 1), `CheckName<K, TKind>` (Task 2), `CollidingActivityNames<C>` and `WorkflowActivityNameClashes<C>` (Task 3).
- Produces: `type ValidateContract<T>` — a structural mirror of `T` with offending properties replaced by string-literal error messages. Intended for `T & ValidateContract<T>` in a parameter position.

**Design note.** The intersection `T & ValidateContract<T>` works because a valid contract maps to a type identical to `T`, making the intersection a no-op. An invalid one maps that property to a string literal, and `T`'s actual value cannot satisfy the intersection — producing "not assignable to" with the message inline.

Where a collision is detected, the error must land on a property the user can see. Attach it to the **`workflows` key itself** rather than trying to point at one activity: the collision is a property of the whole map, and a message naming the offending activity is more useful than a squiggle on an arbitrary one of the two definitions.

**The duration slots to check**, from `builder.ts:470-475` and `builder.ts:632-633`:

- `activityOptions.startToCloseTimeout`, `scheduleToCloseTimeout`, `scheduleToStartTimeout`, `heartbeatTimeout`
- `activityOptions.retry.initialInterval`, `activityOptions.retry.maximumInterval`

`activityOptions` appears on **activity definitions** (`builder.ts:662-664`), both global and workflow-scoped.

- [ ] **Step 1: Write the failing test**

Append to `packages/contract/src/validate-contract.spec.ts`:

```ts
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
  });

  it("replaces a reserved global activity name", () => {
    type C = {
      taskQueue: "orders";
      workflows: { ok: { input: unknown; output: unknown } };
      activities: { __temporal_evil: Act };
    };
    expectTypeOf<TypeEq<ValidateContract<C>, C>>().toEqualTypeOf<false>();
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
  });

  it("flags a workflow name shadowed by a global activity", () => {
    type C = {
      taskQueue: "orders";
      workflows: { processOrder: { input: unknown; output: unknown } };
      activities: { processOrder: Act };
    };
    expectTypeOf<TypeEq<ValidateContract<C>, C>>().toEqualTypeOf<false>();
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
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
pnpm --filter @temporal-contract/contract typecheck
```

Expected: errors reporting `ValidateContract` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/contract/src/validate-contract.ts`:

```ts
/** Validate the two duration slots on an `activityOptions.retry` bag. */
type ValidateRetry<R> = {
  [K in keyof R]: K extends "initialInterval" | "maximumInterval" ? CheckDuration<R[K]> : R[K];
};

/**
 * Validate an `activityOptions` bag: the four timeout slots
 * (`builder.ts:470-475`) plus the two retry intervals
 * (`builder.ts:632-633`).
 */
type ValidateActivityOptions<O> = {
  [K in keyof O]: K extends
    "startToCloseTimeout" | "scheduleToCloseTimeout" | "scheduleToStartTimeout" | "heartbeatTimeout"
    ? CheckDuration<O[K]>
    : K extends "retry"
      ? ValidateRetry<O[K]>
      : O[K];
};

/** Validate one activity definition — currently just its `activityOptions`. */
type ValidateActivity<A> = {
  [K in keyof A]: K extends "activityOptions" ? ValidateActivityOptions<A[K]> : A[K];
};

/**
 * Validate an activities map: keys against the reserved-name rule, values
 * against the activity rules. `TKind` distinguishes global activities from
 * workflow-scoped ones so the error message names the right thing.
 */
type ValidateActivities<A, TKind extends string> = {
  [K in keyof A as CheckName<K, TKind>]: ValidateActivity<A[K]>;
};

/**
 * Validate a signal / query / update map: reserved names only. The schema
 * slots are structural and already enforced by `ContractDefinition`.
 */
type ValidateHandlerMap<M, TKind extends string> = {
  [K in keyof M as CheckName<K, TKind>]: M[K];
};

/**
 * Validate a workflow definition. `errors` and `searchAttributes` are
 * deliberately absent: `builder.ts:435-436` exempts both kinds from the
 * reserved-name rule, and nothing else about them is type-checkable here.
 */
type ValidateWorkflow<W> = {
  [K in keyof W]: K extends "activities"
    ? ValidateActivities<W[K], "activity">
    : K extends "signals"
      ? ValidateHandlerMap<W[K], "signal">
      : K extends "queries"
        ? ValidateHandlerMap<W[K], "query">
        : K extends "updates"
          ? ValidateHandlerMap<W[K], "update">
          : W[K];
};

/** Validate the workflows map: reserved names on keys, definitions on values. */
type ValidateWorkflows<W> = {
  [K in keyof W as CheckName<K, "workflow">]: ValidateWorkflow<W[K]>;
};

/**
 * Cross-cutting checks that no single property owns. Both are reported on the
 * `workflows` slot: a collision is a property of the whole map, and a message
 * naming the offending activity beats a squiggle on an arbitrary one of the
 * two definitions.
 */
type CrossCuttingError<T extends ContractLike> = [CollidingActivityNames<T>] extends [never]
  ? [WorkflowActivityNameClashes<T>] extends [never]
    ? never
    : `Contract error: "${Extract<WorkflowActivityNameClashes<T>, string>}" is both a workflow and a global activity. Workflows and global activities share the root of the worker implementations map — rename one of them.`
  : `Contract error: activity "${Extract<CollidingActivityNames<T>, string>}" is declared with different definitions in more than one scope. Activities share a single flat namespace at runtime — hoist the shared activity to the contract's global "activities" block, reference one shared definition from every scope, or rename one of them.`;

/**
 * Compile-time mirror of a subset of `validateContractDefinition`.
 *
 * A valid contract maps to a type identical to `T`, so `T & ValidateContract<T>`
 * is a no-op and correct code is unaffected. An invalid one maps the offending
 * property to a string literal whose text is the diagnostic, which surfaces as
 * a "not assignable to" error with the guidance inline.
 *
 * The runtime checks in `builder.ts` remain authoritative — this layer is a
 * strictly earlier, strictly narrower warning for typed callers.
 */
export type ValidateContract<T extends ContractLike> = {
  [K in keyof T]: K extends "workflows"
    ? [CrossCuttingError<T>] extends [never]
      ? ValidateWorkflows<T[K]>
      : CrossCuttingError<T>
    : K extends "activities"
      ? ValidateActivities<T[K], "global activity">
      : T[K];
};
```

- [ ] **Step 4: Verify the tests pass**

```bash
pnpm --filter @temporal-contract/contract typecheck
```

Expected: **zero errors.**

- [ ] **Step 5: Positive control on the no-op property**

The most dangerous failure here is `ValidateContract<C>` differing from `C` for a _valid_ contract — that would reject correct user code. Temporarily append:

```ts
// POSITIVE CONTROL — delete before committing.
type _OkContract = {
  taskQueue: "orders";
  workflows: { processOrder: { input: unknown; output: unknown } };
};
const noopControl: TypeEq<ValidateContract<_OkContract>, _OkContract> = false;
```

Run `tsc`. Expected: **exactly one error** on the `noopControl` line (`Type 'false' is not assignable to type 'true'`), proving the no-op assertion is real. Delete and re-run to confirm zero.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @temporal-contract/contract test
pnpm lint
git add packages/contract/src/validate-contract.ts packages/contract/src/validate-contract.spec.ts
git commit -m "feat(contract): compose ValidateContract from the three checks"
```

---

### Task 5: Wire into `defineContract` with a `const` type parameter

**Files:**

- Modify: `packages/contract/src/builder.ts:359-361`
- Modify: `packages/contract/src/validate-contract.spec.ts`

**Interfaces:**

- Consumes: `ValidateContract<T>` from Task 4.
- Produces: the new `defineContract` signature that every downstream package and example compiles against.

**Why `const` is required.** Without it, TypeScript widens `startToCloseTimeout: "5 minutos"` to `string` before `ValidateContract` ever sees it — and `IsMsDuration<string>` is `false` by design, but the widened property never reaches the check as a literal, so the duration validation silently never fires. This was verified: only the `const` variant preserved the literal. Adding the mapped type without `const` would ship a check that appears to work and does nothing — exactly the vacuous-guard failure this codebase keeps hitting.

**Accepted cost.** `const` narrows all inferred literals; arrays in a contract become readonly tuples. 8.0.0 has not shipped, so this is the cheap moment for a signature change.

**Do not touch the function body.** `validateContractDefinition(definition)` stays exactly as it is.

- [ ] **Step 1: Write the failing test**

Append to `packages/contract/src/validate-contract.spec.ts`. Add `import { z } from "zod";` and `import { defineContract } from "./builder.js";` to the top of the file.

```ts
describe("defineContract compile-time rejection", () => {
  it("accepts a well-formed contract and preserves its inferred shape", () => {
    const contract = defineContract({
      taskQueue: "orders",
      workflows: {
        processOrder: {
          input: z.object({ orderId: z.string() }),
          output: z.object({ ok: z.boolean() }),
          activities: {
            charge: {
              input: z.object({ amount: z.number() }),
              output: z.object({ ok: z.boolean() }),
              activityOptions: { startToCloseTimeout: "30s", retry: { initialInterval: "1s" } },
            },
          },
        },
      },
    });
    // `const T` must not degrade inference of the names downstream packages
    // rely on.
    expectTypeOf<keyof typeof contract.workflows>().toEqualTypeOf<"processOrder">();
  });

  it("rejects a reserved workflow name", () => {
    defineContract({
      taskQueue: "orders",
      workflows: {
        // @ts-expect-error -- "__temporal_" is reserved by the Temporal SDK
        __temporal_evil: { input: z.object({}), output: z.object({}) },
      },
    });
  });

  it("rejects a malformed duration", () => {
    defineContract({
      taskQueue: "orders",
      workflows: { ok: { input: z.object({}), output: z.object({}) } },
      activities: {
        charge: {
          input: z.object({}),
          output: z.object({}),
          // @ts-expect-error -- "5 minutos" is not an ms-formatted duration
          activityOptions: { startToCloseTimeout: "5 minutos" },
        },
      },
    });
  });

  it("rejects a workflow name shadowed by a global activity", () => {
    defineContract({
      taskQueue: "orders",
      // @ts-expect-error -- "processOrder" is both a workflow and a global activity
      workflows: { processOrder: { input: z.object({}), output: z.object({}) } },
      activities: { processOrder: { input: z.object({}), output: z.object({}) } },
    });
  });

  it("still accepts one definition shared across two workflows", () => {
    // The runtime escape hatch at builder.ts:816. This must keep compiling.
    const charge = {
      input: z.object({ amount: z.number() }),
      output: z.object({ ok: z.boolean() }),
    };
    defineContract({
      taskQueue: "orders",
      workflows: {
        a: { input: z.object({}), output: z.object({}), activities: { charge } },
        b: { input: z.object({}), output: z.object({}), activities: { charge } },
      },
    });
  });
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
pnpm --filter @temporal-contract/contract typecheck
```

Expected: **three** `Unused '@ts-expect-error' directive` errors — one per negative test — because `defineContract` does not yet validate. This is the discriminating signal: the directives prove the checks are absent right now.

- [ ] **Step 3: Change the signature**

In `packages/contract/src/builder.ts`, add the import alongside the existing type imports:

```ts
import type { ValidateContract } from "./validate-contract.js";
```

Then replace lines 359-361:

```ts
export function defineContract<TContract extends ContractDefinition>(
  definition: TContract,
): TContract {
```

with:

```ts
export function defineContract<const TContract extends ContractDefinition>(
  definition: TContract & ValidateContract<TContract>,
): TContract {
```

**The `const` modifier is load-bearing** — without it, duration string literals widen to `string` and the duration check never fires. Do not remove it as a "simplification".

- [ ] **Step 4: Verify the contract package passes**

```bash
pnpm --filter @temporal-contract/contract typecheck
```

Expected: **zero errors.** The three `@ts-expect-error` directives are now satisfied.

If you instead see errors in `builder.spec.ts` or `types-inference.spec.ts`, do **not** fix them here — record each one (file, line, message) in your report. Task 6 owns that fallout, and the distinction between "the signature broke this" and "this was already broken" is only visible right now.

- [ ] **Step 5: Verify an error message is actually readable**

Create a scratch file `/tmp/msg-check.ts` and compile it to see what a user sees:

```ts
import { z } from "zod";
import { defineContract } from "./packages/contract/src/builder.js";

defineContract({
  taskQueue: "orders",
  workflows: { ok: { input: z.object({}), output: z.object({}) } },
  activities: {
    charge: {
      input: z.object({}),
      output: z.object({}),
      activityOptions: { startToCloseTimeout: "5 minutos" },
    },
  },
});
```

Run `./node_modules/.bin/tsc --noEmit /tmp/msg-check.ts` and **paste the verbatim error text into your report.** The message must contain `5 minutos` and the expected-format guidance. If it is an opaque "not assignable to type 'never'" or the message is truncated past usefulness, that is a finding — report it rather than accepting it.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @temporal-contract/contract test
pnpm lint
git add packages/contract/src/builder.ts packages/contract/src/validate-contract.spec.ts
git commit -m "feat(contract)!: validate contracts at compile time via const type parameter"
```

---

### Task 6: Repo-wide fallout, compile-cost measurement, and the changeset

**Files:**

- Modify: whichever files Task 5 broke (report each; expected candidates are `packages/contract/src/builder.spec.ts`, `packages/contract/src/types-inference.spec.ts`, and the `examples/order-processing-*` packages)
- Create: `.changeset/<generated-name>.md`

**Interfaces:**

- Consumes: the `defineContract` signature from Task 5.
- Produces: a green repo-wide typecheck and a recorded compile-cost measurement.

**Framing.** The `const` narrowing was accepted with eyes open, but _which_ consumers it breaks was not known when the plan was written. Your job is to find out, fix what genuinely needs fixing, and **report anything that needed a change** — the spec calls each one a finding, not something to absorb silently.

The three canaries: `examples/order-processing-{contract,worker,client}`, and the two heavy in-package callers `packages/contract/src/types-inference.spec.ts` and `builder.spec.ts` (1351 lines).

- [ ] **Step 1: Measure the compile cost baseline**

Measure the _pre-change_ cost first, from the merge base:

```bash
git stash list  # ensure clean
BASE=$(git merge-base HEAD main)
git worktree add /tmp/tc-baseline "$BASE"
cd /tmp/tc-baseline && pnpm install --frozen-lockfile
time pnpm --filter @temporal-contract/contract typecheck
```

Record the wall time. Then measure the current branch:

```bash
cd /Users/btravers/Projects/btravstack/temporal-contract
time pnpm --filter @temporal-contract/contract typecheck
```

Also capture the type-instantiation count, which is the number that actually explains a regression:

```bash
pnpm --filter @temporal-contract/contract exec tsc --noEmit --extendedDiagnostics 2>&1 | grep -Ei 'Instantiations|Total time|Check time'
```

**Report all three figures (baseline wall, current wall, instantiation count) in your report.** A regression under ~15% is acceptable; anything larger is a finding to escalate, not to quietly accept.

Clean up: `git worktree remove /tmp/tc-baseline`

- [ ] **Step 2: Run the full repo typecheck and inventory the damage**

```bash
pnpm turbo run typecheck 2>&1 | tee /tmp/typecheck-after.txt
```

**Before changing anything**, write down every failing file and error. This inventory goes in your report.

- [ ] **Step 3: Fix the fallout**

For each failure, the fix depends on the cause:

- **A test that deliberately constructs an invalid contract** to assert the runtime `fail()` — this is expected and _must keep working_, because the runtime checks are still authoritative. Add `@ts-expect-error` with a comment naming which validation now catches it at compile time. Do **not** delete the test: it is the proof that the runtime layer still fires.
- **A readonly-array mismatch** from `const` narrowing (e.g. `nonRetryableErrorTypes: string[]` vs `readonly string[]`) — widen the consuming type to `readonly`, do not cast.
- **A genuine inference degradation** where a downstream type resolves to something narrower or wider than before — stop and report it. That is a design problem, not a fix-in-place problem.

Never silence a failure with `as never`, `as unknown as`, or `any`. If a fix requires one, report it as a finding instead.

- [ ] **Step 4: Verify the whole repo is green**

```bash
pnpm turbo run typecheck
pnpm turbo run test
pnpm lint
```

Expected: all green.

- [ ] **Step 5: Confirm the runtime layer still fires**

This guards the plan's central constraint — that nothing was removed. The runtime checks must still reject an invalid contract that bypasses the types:

```bash
pnpm --filter @temporal-contract/contract test -- builder.spec
```

Expected: pass. If any runtime validation test was deleted rather than annotated in Step 3, restore it.

- [ ] **Step 6: Write the changeset**

Create `.changeset/compile-time-contract-validation.md`:

```markdown
---
"@temporal-contract/contract": major
---

`defineContract` now validates contracts at compile time in addition to runtime.

Three classes of mistake are now `tsc` errors rather than throws at
`defineContract` call time:

- **Temporal-reserved names** — a workflow, activity, signal, query, or update
  named `__temporal_*`, `__stack_trace`, or `__enhanced_stack_trace`. Error
  names and search-attribute names are unaffected, matching the runtime.
- **Malformed `ms` durations** — `startToCloseTimeout: "5 minutos"` and the
  other timeout and retry-interval slots.
- **Flat-namespace activity collisions** — one activity name bound to
  different definitions across scopes, and a workflow name shadowed by a
  global activity. Sharing one `defineActivity` result across scopes still
  compiles, as before.

Every runtime validation is unchanged and still authoritative; this is an
earlier warning for typed callers, not a replacement.

**Breaking:** `defineContract`'s type parameter is now `const`, which
preserves literal types and infers arrays as `readonly` tuples. Code that
assigns a contract to a mutably-typed variable may need a `readonly`
annotation.
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test: absorb const-narrowing fallout and add changeset"
```

---

## Self-Review

**1. Spec coverage.**

| Spec requirement                             | Task                                                         |
| -------------------------------------------- | ------------------------------------------------------------ |
| Reserved names lifted, six kinds only        | Task 2, verified in Task 4                                   |
| Errors/search attributes exempt              | Task 2 Step 1, Task 4 Step 1                                 |
| Duration grammar lifted                      | Task 1                                                       |
| Left-to-right parser (not the naive split)   | Task 1 Step 3                                                |
| Collisions lifted, structural approximation  | Task 3                                                       |
| Identity escape hatch preserved              | Task 3 Steps 1 and 5, Task 5 Step 1                          |
| Workflow vs global activity clash            | Task 3, Task 4                                               |
| `T & ValidateContract<T>` intersection       | Task 4                                                       |
| `const` type parameter added                 | Task 5 Step 3                                                |
| String-literal error messages, never `never` | Global Constraints; Task 5 Step 5 verifies the rendered text |
| All 31 runtime `fail()` sites retained       | Global Constraints; Task 6 Step 5                            |
| Type tests confirmed visited by `tsc`        | Task 1 Step 5 (and a control in every task)                  |
| Negatives via `@ts-expect-error`             | Task 5 Step 1                                                |
| Canary consumers typecheck                   | Task 6 Steps 2-4                                             |
| Compile-time cost measured and reported      | Task 6 Step 1                                                |

No gaps.

**2. Placeholder scan.** No TBDs. Every code step carries the actual code. Task 6 is the one task whose edits cannot be written in advance — the set of broken files is genuinely unknown until Task 5 lands — so it specifies the decision procedure per failure category, the prohibitions (`as never`, `any`), and what to escalate instead of a literal diff.

**3. Type consistency.** `IsMsDuration`, `CheckDuration`, `CheckName`, `CollidingActivityNames`, `WorkflowActivityNameClashes`, `ValidateContract`, `ContractLike`, `TypeEq` are each named identically at definition and every use. `ContractLike` is defined in Task 3 and reused as the constraint in Task 4 — Task 4's implementation depends on Task 3's file state, which the sequencing guarantees.

**One risk the plan cannot eliminate:** Task 4's `ValidateContract` is written against the loose `ContractLike`, but Task 5 applies it to `TContract extends ContractDefinition`, whose real shape involves Standard Schema objects and the `AnyWorkflowDefinition` widened constraint. The interaction between the mapped type and those generics is the plan's least-verified seam. Task 5 Step 4 is where it surfaces; if the mapped type fails to preserve a valid contract there, the fix belongs in `ValidateContract`, not in loosening `defineContract`.
