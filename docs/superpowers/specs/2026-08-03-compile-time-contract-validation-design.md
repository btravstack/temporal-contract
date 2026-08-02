# Compile-time contract validation

**Date:** 2026-08-03
**Status:** Approved
**Scope:** Workstream 3 of 4 in the production-hardening effort

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

| Validation                                                                 | Runtime today           | Lift?                       |
| -------------------------------------------------------------------------- | ----------------------- | --------------------------- |
| Reserved names (`__temporal_*`, `__stack_trace`, `__enhanced_stack_trace`) | `defineContract` throws | **Yes**                     |
| Flat-namespace activity collisions                                         | `defineContract` throws | **Yes**                     |
| `ms` duration grammar                                                      | `defineContract` throws | **Yes**, needs `const T`    |
| Valid JS identifier                                                        | `defineContract` throws | Partially — out of scope    |
| Standard Schema compatibility                                              | structural probe        | **No** — inherently runtime |

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

### The duration grammar needs `const T`

`defineContract` is currently
`defineContract<TContract extends ContractDefinition>(definition: TContract)`
(`packages/contract/src/builder.ts:359`) — **no `const`**. Verified: without
it, `startToCloseTimeout: "5 minutos"` widens to `string` before any type can
inspect it, so the check can never fire. With `const`, the literal survives.

**Accepted cost:** `const` narrows _all_ inferred literals — arrays in a
contract become readonly tuples, string values stay literal. A consumer
assigning a contract to a mutably-typed variable may need a change. This is
acceptable because 8.0.0 has not shipped (14 unreleased changesets, currently
`8.0.0-beta.4`), so the signature change costs nothing now and would be
expensive later.

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

### Validation by intersection

```ts
export function defineContract<const T extends ContractDefinition>(
  definition: T & ValidateContract<T>,
): T;
```

`ValidateContract<T>` is a mapped type that leaves every valid key alone and
replaces each offending one with an error type.

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

| Risk                                                                                        | Mitigation                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compile-time cost of recursive template-literal parsing on every duration in every contract | Measure `tsc` wall time on the repo before and after; the plan gates on it, and the duration piece is revertible independently of the other two                                                                                                                                                                                                  |
| `const` narrowing breaks a consumer                                                         | Three in-repo consumers act as canaries and must typecheck unchanged: the `examples/order-processing-{contract,worker,client}` packages, and the existing heavy `defineContract` callers `packages/contract/src/types-inference.spec.ts` and `builder.spec.ts` (1351 lines). Any change they need is a finding to report, not to absorb silently |
| Error messages worse than the runtime ones they shadow                                      | String-literal error types, message text matched to the runtime `fail()` wording                                                                                                                                                                                                                                                                 |
| Deep recursion hitting TypeScript's instantiation limit on a pathological string            | Bound the numeric-run recursion; test a long input explicitly                                                                                                                                                                                                                                                                                    |

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

1. A reserved workflow / activity / signal / query / update / search-attribute
   / error name is a **compile error**, with the offending name in the message.
2. An activity name declared both globally and workflow-scoped, or under two
   workflows with different definitions, is a **compile error**.
3. A malformed `ms` duration in any `activityOptions` timeout or retry interval
   is a **compile error**, with the offending value in the message.
4. Every runtime `fail()` site still exists and still fires for an untyped
   caller — proven by a test that constructs the violation through an `as never`
   escape.
5. The canary consumers typecheck unchanged under `const T`.
6. The new type-level test file is confirmed to be visited by `tsc` — a
   deliberate violation was observed failing before the suite was trusted.
7. `tsc` wall time across the repo does not regress materially; the measured
   before/after is reported.
