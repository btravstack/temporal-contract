# Compile-time contract validation

**Date:** 2026-08-03
**Status:** Implemented — **with four corrections recorded below**
**Scope:** Workstream 3 of 4 in the production-hardening effort

## Corrections after implementation

Four claims in the original design were **verified false** during
implementation. They are corrected in place below; this section exists so the
history is not lost, because three of the four are the kind of mistake that
looks obviously right on paper.

1. **`const` alone does not make durations checkable.** `DurationValue` was
   `string | number`, which contains no literal types, so a duration literal
   widened to `string` inside the _separate_ `defineActivity` call — before
   `defineContract` ever ran. The fix was to narrow `DurationValue` itself.
   `const` is still required, but for a different case: durations written
   _inline_ in `defineContract`. The two mechanisms are complementary, not
   alternatives.
2. **`T & ValidateContract<T>` hides every error message.** The intersection
   collapses `"5 minutos" & "Invalid duration …"` to `never`, producing
   `Type 'string' is not assignable to type 'never'` — verbatim the error this
   spec rejects below. The wiring is `ValidateContract<T>` **alone**. Inference
   is unaffected.
3. **Key remapping hides messages a second way.** Errors reported by remapping
   a key (`as CheckName<K, …>`) surface as `'__temporal_evil' does not exist in
type …`, which reads as nonsense to the person declaring that property.
   Reserved-name errors go in the **value** position.
4. **The collision check needed to gate on scope count, not definition types.**
   Comparing the _set of types_ bound to a name flags a single scope binding a
   union-typed value, and `IsUnion<never>` resolving to `never` made
   `never extends true` take the true branch. Both were false positives.

**Every defect found during implementation — five in total — was a false
positive: the type layer rejecting code the runtime accepts.** That direction
is the one to design against here.

## Context

`temporal-contract` is in production use where real money depends on it. The
hardening driver is preventive — no incident has occurred.

The four workstreams:

1. Mock-free test architecture — **shipped 2026-08-02 (PR #359)**
2. Determinism & money-safety invariants — **shipped 2026-08-02 (PR #360)**
3. **API/type strength** (this spec)
4. Pattern enforcement — forcing correct usage on end users

The stated bar for this workstream: _misuse should be unrepresentable rather
than merely validated at runtime._

### The premise was partly already satisfied

Surveying the surface first changed the scope. `activityOptionsByName` is
already key-constrained to `ActivityNamesFor<TContract, TWorkflowName>`
(`packages/worker/src/workflow.ts:541-543`) — its runtime `ContractMisuseError`
is defence for JS callers and `as never` escapes, not a type gap. Many of
`defineContract`'s 31 `fail()` sites are `must be an object` / `must be a
string` / `must be a boolean`, all of which TypeScript already enforces for any
typed caller.

So this workstream is narrower than "strengthen the types". It targets the
validations that are **genuinely runtime-only and genuinely type-expressible**:

| Validation                                                                 | Runtime today           | Lift?                                                                          |
| -------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| Reserved names (`__temporal_*`, `__stack_trace`, `__enhanced_stack_trace`) | `defineContract` throws | **Yes**                                                                        |
| Flat-namespace activity collisions                                         | `defineContract` throws | **Yes**                                                                        |
| `ms` duration grammar                                                      | `defineContract` throws | **Yes**, needs a narrowed `DurationValue` **and** `const T` — see correction 1 |
| Valid JS identifier                                                        | `defineContract` throws | Partially — out of scope                                                       |
| Standard Schema compatibility                                              | structural probe        | **No** — inherently runtime                                                    |

## What is NOT changing

**Every runtime check stays.** All 31 `fail()` sites remain exactly as they
are. They are not redundant with the new types: they defend JavaScript
consumers, callers who reach for `as never`, and dynamically-constructed
contracts. Several are not type-expressible at all.

This workstream **adds** a compile-time layer. It removes nothing.

## Feasibility — verified before writing this spec

Each claim below was checked against the installed TypeScript (6.0.3) with a
throwaway prototype, not reasoned about abstractly.

### Reserved names and collisions cost nothing

Both operate on object **keys**, which TypeScript preserves as literals
regardless of `const`. Verified end-to-end: a `__temporal_evil` workflow key
and a `charge` activity declared both globally and workflow-scoped each produce
a compile error, while a well-formed contract compiles clean.

**The reserved-name rule applies to exactly six kinds**, matching
`TEMPORAL_NAMED_KINDS` in `builder.ts:442-449`: workflow, activity, global
activity, signal, query, update. Error names and search-attribute names are
deliberately excluded at runtime, with the rationale documented at
`builder.ts:435-436` — they never become Temporal handler names. The type layer
must mirror this exactly. Rejecting a reserved-looking error name at compile
time would be a **false positive breaking valid contracts**, which is worse
than the gap it closes.

### The collision check must be structural, and that is an approximation

The runtime rule has an escape hatch at `builder.ts:816`: a duplicate activity
name is **allowed** when every scope references the _same object_
(`previousOwner.definition === definition`) — the documented pattern of sharing
one `defineActivity` result across workflows. That test is reference identity,
which the type system cannot observe.

The type-level rule is therefore **structural**: flag an activity name only
when the definitions bound to it are not mutually assignable. Verified against
five cases, with a positive control confirming the assertions discriminate:

| Case                                                       | Runtime  | Types    |
| ---------------------------------------------------------- | -------- | -------- |
| Same definition shared across two workflows                | allowed  | allowed  |
| Different definitions under one name                       | rejected | rejected |
| Global vs workflow-scoped, different definitions           | rejected | rejected |
| Global vs workflow-scoped, same definition (hoist pattern) | allowed  | allowed  |
| No activities declared                                     | allowed  | allowed  |

The one divergence: two **structurally identical but referentially distinct**
definitions pass the type check and still fail at runtime. That direction is
safe — the type layer is permissive, never a false positive — and it is exactly
why the runtime check must stay. This asymmetry is intended, not a defect to
"fix" by tightening the type.

### The duration grammar needs BOTH a narrowed `DurationValue` and `const T`

This section originally claimed `const` alone was sufficient. **It is not**, and
the reason is worth keeping: there are two distinct paths by which a duration
literal reaches `defineContract`, and each loses the literal differently.

**Path 1 — a separate `defineActivity` call** (the pattern the docs teach,
`docs/how-to/tune-activity-options.md:44-52`). `DurationValue` was
`string | number`, which contains **no literal types**, so `"30s"` widened to
`string` during inference _inside `defineActivity`_ — before `defineContract`
ran. `const` on `defineContract` cannot undo that. The fix is to narrow the
type itself:

```ts
export type DurationValue = `${number}${string}` | number | (string & {});
```

Each member is load-bearing, mutation-tested: the template literal is what
preserves literals (one such member anywhere in a union enables literal
inference for _every_ candidate, including `".5s"`); `number` carries numeric
milliseconds; and `string & {}` is what keeps a **computed** string — a timeout
read from config — assignable. Collapsing it to `string` widens every literal
back and silently kills the feature.

**Path 2 — a duration written inline in `defineContract({…})`.** Here there is
no intervening call, so `defineContract`'s own constraint is all inference has
to lean on, and without `const` the constraint-derived contextual type wins and
widens the literal. **This is where `const` is required.**

**Measured cost of `const`, repo-wide: one line.** A single test wrote an
invalid duration inline to assert the _runtime_ throws; the compile-time check
now catches it too, so it carries a `@ts-expect-error` and keeps its runtime
assertion. None of the feared readonly-array narrowing materialized.

### The obvious duration parser is wrong

The natural formulation matches `` `${infer N}${Unit}` ``. It **silently
rejects `"5 minutes"`**, because `"s"` is itself a unit and a suffix of
`"seconds"`, so inference splits the string at the wrong point.

The working formulation consumes the leading numeric run left-to-right, then
requires the remainder (after trimming spaces) to be exactly a unit or empty:

```ts
type SplitNumber<S extends string, Acc extends string = ""> = S extends `${infer C}${infer Rest}`
  ? C extends Digit | "."
    ? SplitNumber<Rest, `${Acc}${C}`>
    : [Acc, S]
  : [Acc, S];
```

Verified with 5 positives compiling (`"30s"`, `"5 minutes"`, `"1.5h"`,
`"1500"`, `"10 seconds"`) and 6 negatives each producing exactly one error
(`"5 minutos"`, `"abc"`, `""`, `"30 sss"`, `"s"`, `"1.2.3s"`).

## Architecture

### Validation by substitution — **not** intersection

```ts
export function defineContract<const T extends ContractDefinition>(
  definition: ValidateContract<T>,
): T;
```

`ValidateContract<T>` is a mapped type that leaves every valid property alone
and replaces each offending one with an error type.

**The parameter is the validated type alone.** The originally-specified
intersection `T & ValidateContract<T>` was implemented and then reverted: it
collapses `"5 minutos" & "Invalid duration …"` to `never` and prints
`Type 'string' is not assignable to type 'never'` — defeating the entire
message design below. Dropping the intersection surfaces the real message, and
literal inference for workflow names and `taskQueue` is identical either way
(verified).

Because the parameter is no longer `T`, the body cannot prove `return
definition` against the generic return type under
`exactOptionalPropertyTypes`. An **implementation signature** typed
identity-style sits below the public overload to absorb that. It is not
publicly callable — a signature with a body never is, once a separate overload
exists — verified by probing explicit type arguments, aliased function values,
and `.call`.

**Errors go in the value position, never by remapping the key.** Remapping
turns a reserved name into `'__temporal_evil' does not exist in type …`, which
tells the user their property does not exist when they are the one declaring
it. Keeping the key and replacing its _value_ with the message type produces a
diagnostic that names both the property and the reason.

### Error messages are string literals, not `never`

This is the difference between the feature being useful and being worse than
what it replaces. Mapping a violation to `never` yields:

```
Type '"5 minutos"' is not assignable to type 'never'.
```

— strictly less helpful than the runtime error. Mapping it to a string literal
carrying the message yields:

```
Type '"5 minutos"' is not assignable to type
'"Invalid duration \"5 minutos\": expected e.g. \"30s\", \"5 minutes\", \"1.5h\", or \"1500\""'.
```

The guidance is in the error, positioned at the offending property. **Every
error type in this workstream must carry its message this way**; a bare `never`
is a defect, not a shortcut.

Message text should match the corresponding runtime `fail()` message where one
exists, so the two layers teach the same thing.

### File structure

- `packages/contract/src/validate-contract.ts` — new. The `ValidateContract<T>`
  mapped type and its constituent helpers (`IsMsDuration`, reserved-name
  detection, collision detection). Kept out of `types.ts` (401 lines, the
  package's largest pure-type module) because it is a distinct concern with its
  own test file.
- `packages/contract/src/validate-contract.spec.ts` — new. Type-level tests.
- `packages/contract/src/builder.ts` — modified. Signature only; the runtime
  body is untouched.

## Testing

Type-level behavior needs type-level tests, and this repo already has the
convention: `packages/*/src/types-inference.spec.ts` uses Vitest's
`expectTypeOf` wrapped in `it(...)`, with the reason documented in its header —
**`expectTypeOf`'s assertion is purely compile-time, so the `it(...)` wrapper
exists to make the type-checker visit the file under the unit project.** New
type-level tests follow that convention exactly.

That detail is load-bearing. A type-level test file that `tsc` never visits
passes unconditionally — the same vacuous-guard failure this project has now
hit repeatedly. The plan must verify the new file is actually type-checked, by
observing a deliberate violation fail before trusting any of it.

- **Positives** — a well-formed contract compiles, verified by `expectTypeOf`
  on the inferred result so the test fails if inference degrades.
- **Negatives** — `@ts-expect-error` on each violation. This is the
  discriminating form: if the violation stops being an error, `@ts-expect-error`
  itself becomes an "unused directive" error, so the test cannot pass vacuously.

**A negative test asserting nothing is the failure mode to avoid here.** During
feasibility work an early negative test used `[] as never`, which typechecks
against any type and proved nothing. Each negative must be written so that
removing the validation makes the test fail.

## Risks

| Risk                                                                                        | Mitigation                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compile-time cost of recursive template-literal parsing on every duration in every contract | **Measured; did not materialize.** Cost is sub-linear in contract size: 10 activities / 50 duration slots → 6,158 instantiations, 0.06s check; 40 activities / 200 slots → 13,508 instantiations, **0.06s** check. 4× the activities, identical check time. The contract package's own +98% instantiation figure is dominated by the type-level test suite, not user-facing cost |
| `const` narrowing breaks a consumer                                                         | Three in-repo consumers act as canaries and must typecheck unchanged: the `examples/order-processing-{contract,worker,client}` packages, and the existing heavy `defineContract` callers `packages/contract/src/types-inference.spec.ts` and `builder.spec.ts` (1351 lines). Any change they need is a finding to report, not to absorb silently                                 |
| Error messages worse than the runtime ones they shadow                                      | String-literal error types, message text matched to the runtime `fail()` wording                                                                                                                                                                                                                                                                                                 |
| Deep recursion hitting TypeScript's instantiation limit on a pathological string            | Bound the numeric-run recursion; test a long input explicitly                                                                                                                                                                                                                                                                                                                    |

## Out of scope

- The bimodal activity proxy — declaring an `errors` map silently changes the
  workflow-side return contract from throwing to `AsyncResult`
  (`packages/worker/src/activities-proxy.ts:141-143`). Correctly typed but
  unpredictable; it is API redesign with a breaking change, not
  type-strengthening. Belongs in its own spec.
- Identifier-validity checking — partially expressible, low value relative to
  the type machinery required.
- Standard Schema compatibility — inherently runtime.
- Idempotency surface and safe defaults — workstream 4.

## Success criteria

1. A reserved workflow / activity / global activity / signal / query / update
   name is a **compile error**, with the offending name in the message. A
   reserved-looking _error_ name or _search-attribute_ name still compiles —
   mirroring the runtime, which excludes those two kinds deliberately.
2. An activity name bound to structurally different definitions — whether
   across two workflows or between global and workflow scope — is a **compile
   error**. Sharing one definition across scopes still compiles, in both the
   workflow-to-workflow and global-to-workflow directions.
3. A workflow name colliding with a global activity name is a **compile
   error**; that rule has no escape hatch and lifts exactly.
4. A malformed `ms` duration in any `activityOptions` timeout or retry interval
   is a **compile error**, with the offending value in the message.
5. Every runtime `fail()` site still exists and still fires for an untyped
   caller — proven by a test that constructs the violation through an `as never`
   escape.
6. The canary consumers typecheck unchanged under `const T`.
7. The new type-level test file is confirmed to be visited by `tsc` — a
   deliberate violation was observed failing before the suite was trusted.
8. `tsc` wall time across the repo does not regress materially; the measured
   before/after is reported.
