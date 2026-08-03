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

/**
 * Invariant type equality (not mere subtyping). Used below to recognize
 * `DurationValue`'s own two template-literal members — `` `${number}${string}` ``
 * and `` `.${number}${string}` `` — when they show up *unresolved*, as
 * opposed to a concrete literal like `"30s"` that merely matches one of the
 * patterns. `extends` alone can't tell those apart: `` "30s" extends
 * `${number}${string}` `` and `` `${number}${string}` extends
 * `${number}${string}` `` are both `true`. Checking both directions is what
 * pins it down to "exactly this type, not a subtype of it."
 */
type IsExactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Validate one duration slot, passing valid values through unchanged.
 *
 * Numbers and `undefined` pass through: the runtime accepts a non-negative
 * finite number of milliseconds, and every duration slot is optional. Only
 * string literals are checked. A valid value maps to itself so
 * `ValidateContract<T>` is a no-op on a valid contract; an invalid one maps
 * to a string literal whose text is the diagnostic, which is what the user
 * sees in the "not assignable to" error.
 *
 * Three shapes pass through unchecked, all for the same underlying reason —
 * there is nothing concrete here to run `IsMsDuration` against:
 *
 * - A non-literal `string` (the `string extends V` branch below). Even
 *   though `types.ts:51`'s `DurationValue` union now preserves literals
 *   through inference for the common case, a computed value (read from
 *   config, etc.) still widens to plain `string` — see that type's doc
 *   comment. Flagging it would reject every contract that sets a duration
 *   that way, a false positive far worse than the gap it closes: the
 *   runtime already validates the actual string at `defineContract` time,
 *   this layer just can't see it.
 * - `DurationValue`'s own two template-literal members, `` `${number}${string}` ``
 *   and `` `.${number}${string}` ``, when they appear *unresolved* rather
 *   than narrowed to a literal — e.g. `ValidateContract<ContractDefinition>`
 *   evaluated on the library's own unparameterized default types, where a
 *   duration slot's apparent type is the pattern itself, not any one
 *   duration string. `IsMsDuration`'s character-by-character parsing
 *   (`SplitNumber`, `TrimLeft`, …) needs a literal to walk; fed the opaque
 *   pattern type instead, `Lowercase` cannot resolve it to a matchable
 *   literal, `SplitNumber` falls through immediately, and the whole check
 *   resolves to `false` — a false positive on a type that denotes "every
 *   string of this shape," most of which are valid. `IsExactly` recognizes
 *   the two patterns by name and passes them through before `IsMsDuration`
 *   ever sees them.
 */
export type CheckDuration<V> = V extends string
  ? string extends V
    ? V
    : IsExactly<V, `${number}${string}`> extends true
      ? V
      : IsExactly<V, `.${number}${string}`> extends true
        ? V
        : IsMsDuration<V> extends true
          ? V
          : `Invalid duration "${V}": expected an ms-formatted string — a number followed by an optional unit ms/s/m/h/d/w/y or its long form, e.g. "30s", "5 minutes", "1.5h" — or a number of milliseconds`
  : V;

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
  | "workflow"
  | "activity"
  | "global activity"
  | "signal"
  | "query"
  | "update";

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
 * Every definition bound to activity name `N`, one tuple-wrapped member per
 * *declaring scope*. One member means every declaring scope agrees; more
 * than one means they disagree.
 *
 * Extraction is `N extends keyof A ? [A[N]] : never`, not `A extends
 * Record<N, infer D> ? D : never`. Two things ride on this:
 *
 * - `N extends keyof A` (matching `ScopesDeclaring`) correctly reports an
 *   optional key as declaring `N` — `keyof { charge?: D }` contains
 *   `"charge"` — where `A extends Record<N, infer D>` does not, because an
 *   optional source property never structurally satisfies a required target
 *   property. Every scope that actually declares `N` therefore contributes
 *   a member here; the type no longer has a `never` case to fall into.
 * - The `[...]` tuple wrap is load-bearing, not decorative: without it, a
 *   *single* scope binding `N` to an already-union-typed value (e.g. the
 *   result of a ternary between two activity definitions) would flatten
 *   into the same shape as *two scopes disagreeing* — both are unions of
 *   more than one member as far as `IsUnion` can see. Wrapping each scope's
 *   contribution in a one-element tuple keeps that union type intact as a
 *   single opaque member, so `IsUnion` counts declaring scopes whose bound
 *   types differ, not the union arms inside any one scope's type.
 */
type DefinitionsFor<C extends ContractLike, N extends PropertyKey> =
  | (N extends keyof GlobalActivitiesOf<C> ? [GlobalActivitiesOf<C>[N]] : never)
  | (C extends { workflows: infer W }
      ? {
          [K in keyof W]: N extends keyof ActivitiesOf<W[K]> ? [ActivitiesOf<W[K]>[N]] : never;
        }[keyof W]
      : never);

/**
 * Which scopes declare activity name `N`, tagged by scope identity rather
 * than by the definition bound there. Mirrors `builder.ts:811`, which only
 * compares definitions once a *previous owner* exists for the name — i.e.
 * once at least two scopes are in play.
 *
 * A name declared in only one scope can never disagree with itself, so
 * gating on scope count here — before `DefinitionsFor` is even consulted —
 * is what makes a single-scope name unconditionally safe, independent of
 * whatever shape (optional key, union-typed value, etc.) its lone binding
 * has.
 *
 * The global scope is tagged `0` rather than a `unique symbol`. Naively,
 * `keyof W` could contain the numeric literal `0` too — a workflow whose key
 * is the string `"0"` has `keyof` type `0`, not `"0"` — which would make the
 * tag ambiguous in principle. In practice this never happens: `builder.ts:
 * 496-499`'s `assertIdentifier` requires every workflow name to match
 * `IDENTIFIER_PATTERN` (`/^[a-zA-Z_$][a-zA-Z0-9_$]*$/`), which a name
 * starting with a digit can never satisfy, so a workflow named `"0"` is
 * already rejected before name-collision checking runs. (The runtime uses a
 * `unique symbol` for `GLOBAL_OWNER`, `builder.ts:789-793`, specifically
 * because *workflow* names have no such restriction there — see that
 * comment. Only *activity* names route through `ScopesDeclaring`.)
 *
 * Membership is tested with `N extends keyof …`, not `… extends Record<N,
 * unknown>`. The two are not equivalent for an optional activity key:
 * `keyof { charge?: D }` still contains `"charge"` (matching how
 * `AllActivityNames` gathers names in the first place), but `{ charge?: D }`
 * does not structurally extend `Record<"charge", unknown>` — TypeScript
 * treats an optional source property as incompatible with a required target
 * property regardless of the value type. `DefinitionsFor` uses the same
 * `N extends keyof …` extraction for the same reason.
 */
type ScopesDeclaring<C extends ContractLike, N extends PropertyKey> =
  | (N extends keyof GlobalActivitiesOf<C> ? 0 : never)
  | (C extends { workflows: infer W }
      ? { [K in keyof W]: N extends keyof ActivitiesOf<W[K]> ? K : never }[keyof W]
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
 *
 * A name is flagged only when at least two scopes declare it (the
 * `ScopesDeclaring` gate) *and* no single bound definition is a supertype of
 * all the others (the `IsUnion` check on `DefinitionsFor`: `IsUnion` returns
 * plain `boolean`, not `true`, whenever the union collapses under mutual
 * assignability — e.g. `Wide` and `Wide & { extra: string }` are not
 * mutually assignable but are still not flagged, since one is a supertype of
 * the other; two scopes binding the exact same union-typed definition
 * collapse the same way, since `DefinitionsFor` tuple-wraps each scope's
 * contribution — see there).
 *
 * The `ScopesDeclaring` gate is checked first and short-circuits to `never`
 * before `DefinitionsFor` is evaluated at all when fewer than two scopes
 * declare the name — so there is no remaining case where a name is flagged
 * despite there being nothing to actually compare.
 */
export type CollidingActivityNames<C extends ContractLike> = {
  [N in AllActivityNames<C>]: IsUnion<ScopesDeclaring<C, N>> extends true
    ? IsUnion<DefinitionsFor<C, N>> extends true
      ? N
      : never
    : never;
}[AllActivityNames<C>];

/**
 * Names used by both a workflow and a global activity. Mirrors
 * `builder.ts:779-787`: workflow implementations and global activity
 * implementations share the root of the worker's implementations map, so a
 * shared name is ambiguous. No escape hatch — this lifts exactly.
 *
 * Guarded against a widened key type on either side. `Extract<keyof
 * GlobalActivitiesOf<C>, keyof W>` is unsound the moment `keyof W` (or
 * `keyof GlobalActivitiesOf<C>`) widens to plain `string` — e.g. `workflows:
 * Record<string, AnyWorkflowDefinition>` — because every string-literal key
 * extends `string`, so `Extract` returns *all* global activity names instead
 * of `never`. That is exactly the shape `defineContract` accepts today (a
 * caller building the `workflows` map dynamically), so without the guard
 * this type falsely flags every activity name as clashing the moment
 * `ValidateContract` is wired into `defineContract`. `string extends keyof W`
 * asks "did the key type widen all the way to `string`?" — true only for the
 * widened case, never for a literal key union.
 */
export type WorkflowActivityNameClashes<C extends ContractLike> = C extends {
  workflows: infer W;
}
  ? string extends keyof W
    ? never
    : string extends keyof GlobalActivitiesOf<C>
      ? never
      : Extract<keyof GlobalActivitiesOf<C>, keyof W>
  : never;

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
    | "startToCloseTimeout"
    | "scheduleToCloseTimeout"
    | "scheduleToStartTimeout"
    | "heartbeatTimeout"
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
 *
 * The reserved-name error is placed in the VALUE position, not remapped onto
 * the key (fix round 2). Remapping the key via `as CheckName<K, TKind>` makes
 * the original key vanish from the mapped type, so a reserved name surfaces
 * as TS2353 ("object literal may only specify known properties... 'X' does
 * not exist") — the carefully built message is never shown, and the user is
 * told a property they wrote themselves "does not exist." Keeping the key and
 * replacing the value with the message instead lands the message on the
 * offending property as a "not assignable to" error, which is visible.
 * `CheckName<K, TKind> extends K` asks "was this name accepted unchanged?" —
 * true for a valid name (where `CheckName` returns `K` itself, so `K extends
 * K` trivially holds) and false for a rejected one (where `CheckName` returns
 * the message literal, which a distinct key literal does not extend).
 */
type ValidateActivities<A, TKind extends string> = {
  [K in keyof A]: CheckName<K, TKind> extends K ? ValidateActivity<A[K]> : CheckName<K, TKind>;
};

/**
 * Validate a signal / query / update map: reserved names only. The schema
 * slots are structural and already enforced by `ContractDefinition`.
 *
 * Value-position error, same reasoning as {@link ValidateActivities} (fix
 * round 2).
 */
type ValidateHandlerMap<M, TKind extends string> = {
  [K in keyof M]: CheckName<K, TKind> extends K ? M[K] : CheckName<K, TKind>;
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

/**
 * Validate the workflows map: reserved names checked, definitions validated.
 *
 * Value-position error, same reasoning as {@link ValidateActivities} (fix
 * round 2) — the key is preserved so the message is visible instead of
 * surfacing as an inscrutable TS2353 "does not exist" error.
 */
type ValidateWorkflows<W> = {
  [K in keyof W]: CheckName<K, "workflow"> extends K
    ? ValidateWorkflow<W[K]>
    : CheckName<K, "workflow">;
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
 * A valid contract maps to a type identical to `T`, so `defineContract`
 * wiring this in as `definition: ValidateContract<TContract>` is a no-op for
 * correct code. An invalid one maps the offending property to a string
 * literal whose text is the diagnostic, which surfaces as a "not assignable
 * to" error with the guidance inline — as long as `ValidateContract<T>` is
 * used *alone* at the call site, not intersected with `T`. `T &
 * ValidateContract<T>` collapses the diagnostic literal against the
 * original property type (e.g. `"5 minutos" & "Invalid duration …"`) to
 * `never`, which hides the message behind an opaque "not assignable to
 * `never`" error — do not wire it that way.
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
