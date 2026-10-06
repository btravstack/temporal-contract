import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { WorkflowStartPolicy } from "./start-policy.js";

/**
 * Base types for validation schemas
 * Any schema that implements the Standard Schema specification
 * This includes Zod, Valibot, ArkType, and other compatible libraries
 */
export type AnySchema = StandardSchemaV1;

/**
 * The Standard Schema type materialized by `defineSignal` / `defineQuery` /
 * `defineUpdate` when their `input` is omitted: validation only accepts an
 * absent payload and always yields `undefined`. Because both type faces are
 * `undefined`, handler inputs infer as `undefined` on the worker side, and
 * `undefined extends ClientInferInput<T>` lets the client detect
 * payload-less sends at the type level.
 */
export type UndefinedInputSchema = StandardSchemaV1<undefined, undefined>;

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
 * string (`"30 seconds"`, `"5m"`, …). Kept as a hand-rolled union rather than
 * Temporal's template-literal `Duration` type so the contract package stays
 * free of `@temporalio/*` dependencies; the worker forwards values to
 * Temporal unchanged.
 *
 * The type is deliberately permissive — it accepts any string. Duration
 * strings are checked at **runtime only**, by `defineContract`, against the
 * `ms` grammar (`MS_DURATION_PATTERN` in `builder.ts`), so a malformed value
 * fails when the contract is defined rather than when the worker schedules
 * the activity. There is no compile-time duration check.
 *
 * - `` `${number}${string}` `` — keeps literal duration strings as
 *   themselves in inferred contract types instead of widening them to
 *   `string`.
 * - `number` — a plain number of milliseconds.
 * - `string & {}` — keeps a *computed* string (e.g. a timeout read from
 *   config) assignable without widening the literals above back to `string`.
 */
export type DurationValue = `${number}${string}` | number | (string & {});

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
 * Contract-level default activity options for a single activity — the
 * portable subset of Temporal's `ActivityOptions`.
 *
 * Declared on `defineActivity` so operational behavior (timeouts, retry
 * policy) ships with the contract as a single source of truth shared by
 * every worker, instead of being scattered per-`declareWorkflow` call.
 *
 * Merge precedence at the worker (least → most specific):
 * `declareWorkflow`'s `activityOptions` (workflow-wide default)
 * → this contract-level `activityOptions` (activity-specific, from the
 * contract author)
 * → `activityOptionsByName` (explicit per-workflow, per-activity override).
 *
 * Two options are deliberately excluded and belong to the worker's
 * `activityOptionsByName` instead:
 *
 * - `taskQueue` — not because queue names are deployment-specific (the
 *   contract's own `taskQueue` is one), but because a per-activity queue here
 *   would name a queue no worker built from this contract polls: a
 *   `TypedWorker` only ever binds to its contract's `taskQueue`. Nothing would
 *   check that some worker serves it, and a mismatch fails silently — the task
 *   sits unpolled until a `scheduleToStartTimeout`/`scheduleToCloseTimeout`
 *   fires, or indefinitely without one. To route an activity to a dedicated
 *   pool, pair an `activityOptionsByName` `taskQueue` override with an
 *   activity-only contract on that queue, sharing the queue name as a
 *   constant.
 * - `cancellationType` — how a deployment wants in-flight work torn down.
 */
export type ContractActivityOptions = {
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
  readonly activityOptions?: ContractActivityOptions;
  /**
   * Derive this activity's **idempotency key** from its input.
   *
   * Temporal runs an activity **at least once**: a retry, a worker crash, or
   * a completion that succeeded but was never recorded all re-run the
   * implementation. Making the effect idempotent is the application's job,
   * and the usual remedy is handing a stable key to the downstream API
   * (Stripe's `Idempotency-Key`, and its equivalents). Declaring the key here
   * means the caller and the implementation cannot disagree about what it is.
   *
   * The function receives the **validated** input (post-parse, so schema
   * transforms have already run) and must be pure and deterministic: the same
   * input has to produce the same key on every attempt, or the key protects
   * nothing.
   *
   * Being derived from the *payload* rather than from Temporal's own
   * identifiers is what makes it stable across activity retries, worker
   * crashes, **and** a fresh workflow execution started with the same inputs.
   * (`Context.current().info.activityId` looks like an alternative and is
   * not: it is a per-run command sequence number, so a re-run that branches
   * differently before this call gets a different value.)
   *
   * The parameter is typed `never` **here**, in the structural definition, so
   * a contract written as a plain object literal (`satisfies
   * ContractDefinition`) still accepts a derivation that narrows its input —
   * a property-position function type is contravariant in its parameter, and
   * this slot's `TInput` is only known once a concrete schema is bound.
   * `defineActivity` re-states the slot against the real input type, so the
   * lambda written there is contextually typed and checked.
   *
   * The key reaches the implementation verbatim. Two activities sharing a
   * downstream keyspace must therefore disambiguate in their own derivations
   * (`` `charge:${orderId}` `` vs `` `refund:${orderId}` ``) — handing a
   * gateway one key for two opposite operations is the failure to avoid.
   *
   * Key on the **identity of the operation**, not on its parameters. A
   * customer and an amount describe a charge but do not identify it: the same
   * customer legitimately placing two orders of the same value would produce
   * one key, and the second charge would be swallowed as a replay of the
   * first. Good sources, in rough order of preference:
   *
   * - a business identifier already in the input (`orderId`, `invoiceId`) —
   *   add it to the input schema if it is not there yet, as this example does;
   * - a dedicated `idempotencyKey` field in the input, minted by the caller
   *   when no natural identifier exists;
   * - the **workflow ID**, which is per-execution and — when the contract
   *   derives it (see {@link WorkflowDefinition.workflowId}) — is itself a
   *   function of the payload. Read it inside the activity from
   *   `Context.current().info.workflowExecution.workflowId`, and combine it
   *   with a per-call discriminator if the same activity runs more than once
   *   in a workflow.
   *
   * @example
   * ```ts
   * const chargeCard = defineActivity({
   *   // `orderId` is in the input for the key's sake: it identifies the
   *   // charge, where customer and amount only describe it.
   *   input: z.object({
   *     orderId: z.string(),
   *     customerId: z.string(),
   *     amount: z.number(),
   *   }),
   *   output: PaymentSchema,
   *   idempotencyKey: ({ orderId }) => `charge:${orderId}`,
   * });
   * ```
   */
  readonly idempotencyKey?: (input: never) => string;
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
  /**
   * Derive this workflow's **workflow ID** from its input.
   *
   * Declaring it moves the ID from the caller to the contract: every
   * `startWorkflow` / `executeWorkflow` / `signalWithStart` computes the ID
   * from the payload, and passing one explicitly becomes a type error. That
   * is what makes {@link startPolicy} mean anything — a caller free to pass
   * `crypto.randomUUID()` defeats `"once-per-id"` silently, because every
   * start gets a fresh ID and the policy never fires.
   *
   * The function receives the **validated** input and must be pure: the same
   * payload has to produce the same ID on every call, or two starts of the
   * same logical request will not collide.
   *
   * NOT applied to `schedule.create`, which generates one ID per firing —
   * a scheduled run wants a distinct execution, not deduplication.
   *
   * The parameter is typed `never` here for the same reason as an activity's
   * `idempotencyKey` (a property-position function type is contravariant, and
   * plain-object contracts must stay assignable); `defineWorkflow` re-states
   * the slot against the bound input schema, so the lambda written there is
   * contextually typed.
   *
   * @example
   * ```ts
   * const processOrder = defineWorkflow({
   *   input: OrderSchema,
   *   output: OrderResultSchema,
   *   workflowId: ({ orderId }) => orderId,
   *   startPolicy: "retry-if-failed",
   * });
   * ```
   */
  readonly workflowId?: (input: never) => string;
  /**
   * Whether this workflow is safe to re-run under a workflow ID that has
   * already been used. Applied by the client to every `startWorkflow` /
   * `executeWorkflow` / `signalWithStart`, and by the worker to every
   * `context.startChildWorkflow` / `context.executeChildWorkflow` of this
   * workflow. Neither offers a per-call `workflowIdReusePolicy` override: the
   * policy is the contract's.
   *
   * NOT applied to `schedule.create` — the schedule action type has no
   * `workflowIdReusePolicy` field, so a schedule action pinning a fixed
   * `workflowId` gets Temporal's own default (`ALLOW_DUPLICATE`) regardless
   * of this policy.
   *
   * Required so the question is asked once per workflow rather than
   * silently inheriting Temporal's `ALLOW_DUPLICATE`.
   *
   * Named for what it governs — Temporal's `workflowIdReusePolicy` — rather
   * than for idempotency in general. It does **not** make a workflow
   * idempotent, and it says nothing about an activity running twice under
   * Temporal's at-least-once guarantee; that is an activity's
   * `idempotencyKey`.
   */
  readonly startPolicy: WorkflowStartPolicy;
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
 * `TDef["errors"]` directly) for the same reasons as {@link InferSignalNames}:
 * union definitions yield the union of their error maps, and the optional
 * property is tolerated under `exactOptionalPropertyTypes`.
 */
export type InferDeclaredErrors<TDef> = TDef extends {
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
export type InferSignalNames<W extends AnyWorkflowDefinition> = W extends {
  signals?: infer S;
}
  ? S extends Record<string, SignalDefinition>
    ? keyof S & string
    : never
  : never;

/**
 * Extract query names declared on a workflow as a string union, or `never`
 * if the workflow declares no queries. See {@link InferSignalNames} for the
 * rationale behind the distributive `infer`-based shape.
 */
export type InferQueryNames<W extends AnyWorkflowDefinition> = W extends {
  queries?: infer Q;
}
  ? Q extends Record<string, QueryDefinition>
    ? keyof Q & string
    : never
  : never;

/**
 * Extract update names declared on a workflow as a string union, or `never`
 * if the workflow declares no updates. See {@link InferSignalNames} for the
 * rationale behind the distributive `infer`-based shape.
 */
export type InferUpdateNames<W extends AnyWorkflowDefinition> = W extends {
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
