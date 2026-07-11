import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Base types for validation schemas
 * Any schema that implements the Standard Schema specification
 * This includes Zod, Valibot, ArkType, and other compatible libraries
 */
export type AnySchema = StandardSchemaV1;

/**
 * Definition of a typed domain error on an activity or workflow.
 *
 * Declared under the `errors` map of `defineActivity` / `defineWorkflow`,
 * keyed by error name. The name becomes the `ApplicationFailure.type`
 * discriminator on the wire, so callers (and Temporal retry policies via
 * `retry.nonRetryableErrorTypes`) can branch on it.
 *
 * - `data` — optional Standard Schema for the structured payload carried in
 *   `ApplicationFailure.details`. Validated on the producing side before the
 *   failure crosses the network boundary, and again when it is rehydrated on
 *   the consuming side.
 * - `message` — default human-readable message when the producer doesn't
 *   supply one at construction time.
 * - `nonRetryable` — when `true`, Temporal stops retrying immediately. This
 *   lives on the contract (not the call site) so retry semantics are part of
 *   the shared source of truth. Defaults to `false` (retryable).
 */
export type ErrorDefinition<TData extends AnySchema = AnySchema> = {
  readonly data?: TData;
  readonly message?: string;
  readonly nonRetryable?: boolean;
};

/**
 * A Temporal duration: either a number of milliseconds or an `ms`-formatted
 * string (`"30 seconds"`, `"5m"`, …). Kept as `string | number` rather than
 * Temporal's template-literal `Duration` type so the contract package stays
 * free of `@temporalio/*` dependencies; the worker forwards values to
 * Temporal unchanged.
 */
export type DurationValue = string | number;

/**
 * Portable subset of Temporal's `RetryPolicy`, usable in contract-level
 * activity defaults. Field names and semantics match
 * `@temporalio/common`'s `RetryPolicy` one-to-one.
 */
export type ActivityRetryPolicy = {
  readonly initialInterval?: DurationValue;
  readonly maximumInterval?: DurationValue;
  readonly backoffCoefficient?: number;
  readonly maximumAttempts?: number;
  readonly nonRetryableErrorTypes?: readonly string[];
};

/**
 * Contract-level default `ActivityOptions` for a single activity.
 *
 * Declared on `defineActivity` so operational behavior (timeouts, retry
 * policy) ships with the contract as a single source of truth shared by
 * every worker, instead of being scattered per-`declareWorkflow` call.
 *
 * Merge precedence at the worker (least → most specific):
 * `declareWorkflow`'s `activityOptions` (workflow-wide default)
 * → this `defaultOptions` (activity-specific, from the contract author)
 * → `activityOptionsByName` (explicit per-workflow, per-activity override).
 *
 * Deployment-specific concerns (`taskQueue` routing, cancellation type) are
 * deliberately excluded — those belong to the worker's
 * `activityOptionsByName`, not the portable contract.
 */
export type ActivityDefaultOptions = {
  readonly startToCloseTimeout?: DurationValue;
  readonly scheduleToCloseTimeout?: DurationValue;
  readonly scheduleToStartTimeout?: DurationValue;
  readonly heartbeatTimeout?: DurationValue;
  readonly retry?: ActivityRetryPolicy;
};

/**
 * Definition of an activity
 */
export type ActivityDefinition<
  TInput extends AnySchema = AnySchema,
  TOutput extends AnySchema = AnySchema,
  TErrors extends Record<string, ErrorDefinition> = Record<string, ErrorDefinition>,
> = {
  readonly input: TInput;
  readonly output: TOutput;
  readonly errors?: TErrors;
  readonly defaultOptions?: ActivityDefaultOptions;
};

/**
 * Definition of a signal
 */
export type SignalDefinition<TInput extends AnySchema = AnySchema> = {
  readonly input: TInput;
};

/**
 * Definition of a query
 */
export type QueryDefinition<
  TInput extends AnySchema = AnySchema,
  TOutput extends AnySchema = AnySchema,
> = {
  readonly input: TInput;
  readonly output: TOutput;
};

/**
 * Definition of an update
 */
export type UpdateDefinition<
  TInput extends AnySchema = AnySchema,
  TOutput extends AnySchema = AnySchema,
> = {
  readonly input: TInput;
  readonly output: TOutput;
};

/**
 * The seven Temporal search attribute kinds.
 *
 * Mirrors `@temporalio/common`'s `SearchAttributeType` so values flow into
 * Temporal's `typedSearchAttributes` API unchanged.
 */
export type SearchAttributeKind =
  | "TEXT"
  | "KEYWORD"
  | "INT"
  | "DOUBLE"
  | "BOOL"
  | "DATETIME"
  | "KEYWORD_LIST";

/**
 * Map each {@link SearchAttributeKind} to its TypeScript representation.
 *
 * - `TEXT` / `KEYWORD` → `string`
 * - `INT` / `DOUBLE` → `number`
 * - `BOOL` → `boolean`
 * - `DATETIME` → `Date`
 * - `KEYWORD_LIST` → `string[]`
 */
export type SearchAttributeKindToType<T extends SearchAttributeKind> = {
  TEXT: string;
  KEYWORD: string;
  INT: number;
  DOUBLE: number;
  BOOL: boolean;
  DATETIME: Date;
  KEYWORD_LIST: string[];
}[T];

/**
 * Definition of a typed search attribute on a workflow.
 */
export type SearchAttributeDefinition<TKind extends SearchAttributeKind = SearchAttributeKind> = {
  readonly kind: TKind;
};

/**
 * Definition of a workflow.
 *
 * Generic parameters preserve the schema literal types of `input`/`output`
 * and the declared shape of activities/signals/queries/updates/search
 * attributes through `defineWorkflow` so client and worker call sites can
 * infer typed payloads. Empty-collection generics default to
 * `Record<string, never>` so that, when no signals/queries/updates/etc. are
 * declared, `keyof` resolves to `never` rather than `string` — turning typos
 * in `signalName`/`queryName`/`updateName` into compile-time errors.
 */
export type WorkflowDefinition<
  TInput extends AnySchema = AnySchema,
  TOutput extends AnySchema = AnySchema,
  TActivities extends Record<string, ActivityDefinition> = Record<string, never>,
  TSignals extends Record<string, SignalDefinition> = Record<string, never>,
  TQueries extends Record<string, QueryDefinition> = Record<string, never>,
  TUpdates extends Record<string, UpdateDefinition> = Record<string, never>,
  TSearchAttributes extends Record<string, SearchAttributeDefinition> = Record<string, never>,
  TErrors extends Record<string, ErrorDefinition> = Record<string, never>,
> = {
  readonly input: TInput;
  readonly output: TOutput;
  readonly activities?: TActivities;
  readonly signals?: TSignals;
  readonly queries?: TQueries;
  readonly updates?: TUpdates;
  readonly searchAttributes?: TSearchAttributes;
  readonly errors?: TErrors;
};

/**
 * Widened constraint variant of {@link WorkflowDefinition}.
 *
 * `WorkflowDefinition` (no args) resolves the empty-record generics to
 * `Record<string, never>`, which is the right default for fresh callers but
 * too narrow as a *constraint* — a Record-of-WorkflowDefinition constraint
 * built from it would reject any literal whose `activities`, `signals`,
 * `queries`, or `updates` block is non-empty. `AnyWorkflowDefinition`
 * widens those generics back to their permissive bounds so it can act as
 * the value of `Record<string, …>` in `ContractDefinition` without
 * preventing real workflow definitions from satisfying the constraint.
 */
export type AnyWorkflowDefinition = WorkflowDefinition<
  AnySchema,
  AnySchema,
  Record<string, ActivityDefinition>,
  Record<string, SignalDefinition>,
  Record<string, QueryDefinition>,
  Record<string, UpdateDefinition>,
  Record<string, SearchAttributeDefinition>,
  Record<string, ErrorDefinition>
>;

/**
 * Extract the declared `errors` map from an activity or workflow definition,
 * or `never` when the definition declares none.
 *
 * The conditional is distributive and `infer`-based (rather than indexing
 * `TDef["errors"]` directly) for the same reasons as {@link SignalNamesOf}:
 * union definitions yield the union of their error maps, and the optional
 * property is tolerated under `exactOptionalPropertyTypes`.
 */
export type DeclaredErrorsOf<TDef> = TDef extends {
  errors: infer TErrors;
}
  ? TErrors extends Record<string, ErrorDefinition>
    ? TErrors
    : never
  : never;

/**
 * Consumer-side data payload of a declared error: the `data` schema's
 * *output* type (post-transform), or `undefined` when the error declares no
 * `data` schema. This is the shape a workflow sees after an activity's
 * failure is rehydrated, and a client sees after a workflow's failure is
 * rehydrated.
 */
export type InferErrorData<TDef extends ErrorDefinition> = TDef extends {
  data: infer TSchema extends AnySchema;
}
  ? StandardSchemaV1.InferOutput<TSchema>
  : undefined;

/**
 * Producer-side data payload of a declared error: the `data` schema's
 * *input* type (pre-transform) — what an implementation passes to the typed
 * error constructor before boundary validation runs.
 */
export type InferErrorDataInput<TDef extends ErrorDefinition> = TDef extends {
  data: infer TSchema extends AnySchema;
}
  ? StandardSchemaV1.InferInput<TSchema>
  : undefined;

/**
 * Extract signal names declared on a workflow as a string union, or `never`
 * if the workflow declares no signals. Used to constrain `signalName` call
 * sites so typos surface at compile time instead of runtime.
 *
 * The conditional is intentionally distributive over `W` (rather than indexing
 * `W["signals"]` directly) so that union workflow types — e.g. discriminated
 * unions of workflow definitions — yield the *union* of their signal names
 * rather than the intersection (`keyof (A | B)` is the intersection of keys,
 * which usually collapses to `never`). Destructuring `signals` via
 * `infer S` also tolerates the property being absent or `undefined` under
 * `exactOptionalPropertyTypes`.
 */
export type SignalNamesOf<W extends AnyWorkflowDefinition> = W extends {
  signals?: infer S;
}
  ? S extends Record<string, SignalDefinition>
    ? keyof S & string
    : never
  : never;

/**
 * Extract query names declared on a workflow as a string union, or `never`
 * if the workflow declares no queries. See {@link SignalNamesOf} for the
 * rationale behind the distributive `infer`-based shape.
 */
export type QueryNamesOf<W extends AnyWorkflowDefinition> = W extends {
  queries?: infer Q;
}
  ? Q extends Record<string, QueryDefinition>
    ? keyof Q & string
    : never
  : never;

/**
 * Extract update names declared on a workflow as a string union, or `never`
 * if the workflow declares no updates. See {@link SignalNamesOf} for the
 * rationale behind the distributive `infer`-based shape.
 */
export type UpdateNamesOf<W extends AnyWorkflowDefinition> = W extends {
  updates?: infer U;
}
  ? U extends Record<string, UpdateDefinition>
    ? keyof U & string
    : never
  : never;

/**
 * DIRECTION-AWARE SCHEMA INFERENCE PRIMITIVES
 *
 * A Standard Schema has two type faces: `InferInput` (what a producer hands
 * to validation, pre-transform) and `InferOutput` (what validation yields,
 * post-transform). Which face applies depends on which side of the network
 * boundary you sit on, so the four primitives below encode the perspective
 * once — the worker and client packages re-export them rather than each
 * keeping a local copy.
 */

/**
 * Infer input type from a definition (worker perspective)
 * Worker receives the output type (after input schema parsing/transformation)
 */
export type WorkerInferInput<T extends { input: AnySchema }> = StandardSchemaV1.InferOutput<
  T["input"]
>;

/**
 * Infer output type from a definition (worker perspective)
 * Worker returns the input type (before output schema parsing/transformation)
 */
export type WorkerInferOutput<T extends { output: AnySchema }> = StandardSchemaV1.InferInput<
  T["output"]
>;

/**
 * Infer input type from a definition (client perspective)
 * Client sends the input type (before input schema parsing/transformation)
 */
export type ClientInferInput<T extends { input: AnySchema }> = StandardSchemaV1.InferInput<
  T["input"]
>;

/**
 * Infer output type from a definition (client perspective)
 * Client receives the output type (after output schema parsing/transformation)
 */
export type ClientInferOutput<T extends { output: AnySchema }> = StandardSchemaV1.InferOutput<
  T["output"]
>;

/**
 * Contract definition containing workflows and optional global activities
 */
export type ContractDefinition<
  TWorkflows extends Record<string, AnyWorkflowDefinition> = Record<string, AnyWorkflowDefinition>,
  TActivities extends Record<string, ActivityDefinition> = Record<string, ActivityDefinition>,
> = {
  readonly taskQueue: string;
  readonly workflows: TWorkflows;
  readonly activities?: TActivities;
};

/**
 * UTILITY TYPES
 */

/**
 * Extract workflow names from a contract as a union type
 *
 * @example
 * ```typescript
 * type MyWorkflowNames = InferWorkflowNames<typeof myContract>;
 * // "processOrder" | "sendNotification"
 * ```
 */
export type InferWorkflowNames<TContract extends ContractDefinition> =
  keyof TContract["workflows"] & string;

/**
 * Extract activity names from a contract (global activities) as a union type
 *
 * @example
 * ```typescript
 * type MyActivityNames = InferActivityNames<typeof myContract>;
 * // "log" | "sendEmail"
 * ```
 */
export type InferActivityNames<TContract extends ContractDefinition> =
  TContract["activities"] extends Record<string, ActivityDefinition>
    ? keyof TContract["activities"] & string
    : never;

/**
 * Extract all workflows from a contract with their definitions
 *
 * @example
 * ```typescript
 * type MyWorkflows = InferContractWorkflows<typeof myContract>;
 * ```
 */
export type InferContractWorkflows<TContract extends ContractDefinition> = TContract["workflows"];
