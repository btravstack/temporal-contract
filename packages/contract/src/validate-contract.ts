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
