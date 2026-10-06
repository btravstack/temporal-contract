import type { StandardSchemaV1 } from "@standard-schema/spec";

import type {
  ActivityDefinition,
  AnySchema,
  AnyWorkflowDefinition,
  ContractDefinition,
  QueryDefinition,
  SearchAttributeDefinition,
  SearchAttributeKind,
  SignalDefinition,
  UndefinedInputSchema,
  UpdateDefinition,
} from "./types.js";

/**
 * Types every key of `T` that `TShape` doesn't declare as `never`, so an
 * inferred definition literal carrying a misspelled key fails to compile
 * (generic inference otherwise absorbs the extra key silently).
 */
type NoExcessKeys<T, TShape> = { readonly [K in Exclude<keyof T, keyof TShape>]: never };

// Exported builders first (classic functions for hoisting)

/**
 * Define a Temporal activity with type-safe input and output schemas.
 *
 * Activities are the building blocks of Temporal workflows that execute business logic
 * and interact with external services. This function preserves TypeScript types while
 * providing a consistent structure for activity definitions.
 *
 * @template TActivity - The activity definition type with input/output schemas
 * @param definition - The activity definition containing input and output schemas
 * @returns The same definition with preserved types for type inference
 *
 * @example
 * ```typescript
 * import { defineActivity } from '@temporal-contract/contract';
 * import { z } from 'zod';
 *
 * export const sendEmail = defineActivity({
 *   input: z.object({
 *     to: z.string().email(),
 *     subject: z.string(),
 *     body: z.string(),
 *   }),
 *   output: z.object({
 *     messageId: z.string(),
 *     sentAt: z.date(),
 *   }),
 *   // Typed domain errors — the error name becomes the
 *   // `ApplicationFailure.type` on the wire, `data` its validated payload,
 *   // and `nonRetryable` drives Temporal's retry policy from the contract.
 *   errors: {
 *     RecipientRejected: {
 *       data: z.object({ reason: z.string() }),
 *       nonRetryable: true,
 *     },
 *   },
 *   // Contract-level ActivityOptions defaults shared by every worker.
 *   // Merge precedence: declareWorkflow's activityOptions
 *   // < this contract-level activityOptions < activityOptionsByName.
 *   activityOptions: {
 *     startToCloseTimeout: "30 seconds",
 *     retry: { maximumAttempts: 5 },
 *   },
 * });
 * ```
 */
export function defineActivity<
  TInput extends AnySchema,
  TOutput extends AnySchema,
  TActivity extends ActivityDefinition<TInput, TOutput>,
>(
  definition: TActivity & {
    readonly input: TInput;
    readonly output: TOutput;
    /**
     * Re-stated against the bound input schema (the structural definition
     * types it `never` — see {@link ActivityDefinition}), so this lambda's
     * parameter is contextually typed as the activity's validated input.
     */
    readonly idempotencyKey?: (input: StandardSchemaV1.InferOutput<TInput>) => string;
  } & NoExcessKeys<TActivity, ActivityDefinition>,
): TActivity {
  return definition;
}

/**
 * Define a Temporal signal with type-safe input schema.
 *
 * Signals are asynchronous messages sent to running workflows to update their state
 * or trigger certain behaviors. This function ensures type safety for signal payloads.
 *
 * @template TSignal - The signal definition type with input schema
 * @param definition - The signal definition containing input schema
 * @returns The same definition with preserved types for type inference
 *
 * `input` may be omitted for payload-less signals: the definition then
 * carries a materialized schema whose validated value is always `undefined`,
 * so the handler input infers as `undefined` — no `z.void()` ceremony.
 *
 * @example
 * ```typescript
 * import { defineSignal } from '@temporal-contract/contract';
 * import { z } from 'zod';
 *
 * export const approveOrder = defineSignal({
 *   input: z.object({
 *     orderId: z.string(),
 *     approvedBy: z.string(),
 *   }),
 * });
 *
 * // Payload-less signal — the handler input is `undefined`.
 * export const shutdown = defineSignal();
 * ```
 */
export function defineSignal<TSignal extends SignalDefinition>(
  definition: TSignal & NoExcessKeys<TSignal, SignalDefinition>,
): TSignal;
export function defineSignal(definition?: {
  input?: undefined;
}): SignalDefinition<UndefinedInputSchema>;
export function defineSignal(
  definition?: SignalDefinition | { input?: undefined },
): SignalDefinition {
  return definition?.input ? (definition as SignalDefinition) : { input: undefinedInputSchema };
}

/**
 * Define a Temporal query with type-safe input and output schemas.
 *
 * Queries allow you to read the current state of a running workflow without
 * modifying it. They are synchronous and should not perform any mutations.
 *
 * **Synchronous validation required.** Temporal query handlers must complete
 * synchronously, so the input and output schemas you pass here must validate
 * synchronously. In practice this rules out async refinements (e.g. Zod's
 * `.refine(async (x) => …)`). Standard Schema doesn't expose the sync/async
 * distinction at the type level, so the worker checks at runtime and throws
 * if it ever receives a `Promise` from `~standard.validate`. Use plain Zod /
 * Valibot / ArkType object schemas without async refinements.
 *
 * @template TQuery - The query definition type with input/output schemas
 * @param definition - The query definition containing input and output schemas
 * @returns The same definition with preserved types for type inference
 *
 * `input` may be omitted for argument-less queries: the definition then
 * carries a materialized schema whose validated value is always `undefined`,
 * so the handler input infers as `undefined` — no `z.void()` ceremony.
 *
 * @example
 * ```typescript
 * import { defineQuery } from '@temporal-contract/contract';
 * import { z } from 'zod';
 *
 * export const getOrderStatus = defineQuery({
 *   input: z.object({ orderId: z.string() }),
 *   output: z.object({
 *     status: z.enum(['pending', 'processing', 'completed', 'failed']),
 *     updatedAt: z.date(),
 *   }),
 * });
 *
 * // Argument-less query — the handler input is `undefined`.
 * export const getProgress = defineQuery({
 *   output: z.object({ percent: z.number() }),
 * });
 * ```
 */
export function defineQuery<TQuery extends QueryDefinition>(
  definition: TQuery & NoExcessKeys<TQuery, QueryDefinition>,
): TQuery;
export function defineQuery<TOutput extends AnySchema>(definition: {
  input?: undefined;
  output: TOutput;
}): QueryDefinition<UndefinedInputSchema, TOutput>;
export function defineQuery(
  definition: QueryDefinition | { input?: undefined; output: AnySchema },
): QueryDefinition {
  return definition.input
    ? (definition as QueryDefinition)
    : { input: undefinedInputSchema, output: definition.output };
}

/**
 * Define a Temporal update with type-safe input and output schemas.
 *
 * Updates are similar to signals but return a value and wait for the workflow
 * to process them before completing. They provide a synchronous way to modify
 * workflow state and get immediate feedback.
 *
 * @template TUpdate - The update definition type with input/output schemas
 * @param definition - The update definition containing input and output schemas
 * @returns The same definition with preserved types for type inference
 *
 * `input` may be omitted for argument-less updates: the definition then
 * carries a materialized schema whose validated value is always `undefined`,
 * so the handler input infers as `undefined` — no `z.void()` ceremony.
 *
 * @example
 * ```typescript
 * import { defineUpdate } from '@temporal-contract/contract';
 * import { z } from 'zod';
 *
 * export const updateOrderQuantity = defineUpdate({
 *   input: z.object({
 *     orderId: z.string(),
 *     newQuantity: z.number().positive(),
 *   }),
 *   output: z.object({
 *     success: z.boolean(),
 *     totalPrice: z.number(),
 *   }),
 * });
 *
 * // Argument-less update — the handler input is `undefined`.
 * export const restock = defineUpdate({
 *   output: z.object({ restocked: z.boolean() }),
 * });
 * ```
 */
export function defineUpdate<TUpdate extends UpdateDefinition>(
  definition: TUpdate & NoExcessKeys<TUpdate, UpdateDefinition>,
): TUpdate;
export function defineUpdate<TOutput extends AnySchema>(definition: {
  input?: undefined;
  output: TOutput;
}): UpdateDefinition<UndefinedInputSchema, TOutput>;
export function defineUpdate(
  definition: UpdateDefinition | { input?: undefined; output: AnySchema },
): UpdateDefinition {
  return definition.input
    ? (definition as UpdateDefinition)
    : { input: undefinedInputSchema, output: definition.output };
}

/**
 * Define a typed search attribute on a workflow.
 *
 * Search attributes are indexed on Temporal's visibility store and let you
 * query / filter workflow executions by domain attributes. Declaring them on
 * the contract means the client's workflow-start options and (eventually)
 * the worker's search-attribute reader are constrained to declared keys
 * with the right value types.
 *
 * @example
 * ```typescript
 * import { defineSearchAttribute } from '@temporal-contract/contract';
 *
 * defineWorkflow({
 *   input: z.object({ orderId: z.string() }),
 *   output: z.object({ status: z.string() }),
 *   startPolicy: 'allow-duplicate',
 *   searchAttributes: {
 *     customerId: defineSearchAttribute({ kind: 'KEYWORD' }),
 *     priority: defineSearchAttribute({ kind: 'INT' }),
 *     placedAt: defineSearchAttribute({ kind: 'DATETIME' }),
 *   },
 * });
 * ```
 *
 * The seven Temporal kinds map to TypeScript types like so:
 *
 * | kind            | TS type   |
 * | --------------- | --------- |
 * | `TEXT`          | `string`  |
 * | `KEYWORD`       | `string`  |
 * | `INT`           | `number`  |
 * | `DOUBLE`        | `number`  |
 * | `BOOL`          | `boolean` |
 * | `DATETIME`      | `Date`    |
 * | `KEYWORD_LIST`  | `string[]`|
 */
export function defineSearchAttribute<TKind extends SearchAttributeKind>(
  definition: SearchAttributeDefinition<TKind>,
): SearchAttributeDefinition<TKind> {
  return definition;
}

/**
 * Define a Temporal workflow with type-safe input, output, and associated operations.
 *
 * Workflows are durable functions that orchestrate activities, handle timeouts,
 * and manage long-running processes. This function provides type safety for the
 * entire workflow definition including activities, signals, queries, and updates.
 *
 * @template TWorkflow - The workflow definition type with all associated schemas
 * @param definition - The workflow definition containing input, output, and operations
 * @returns The same definition with preserved types for type inference
 *
 * @example
 * ```typescript
 * import { defineWorkflow, defineActivity, defineSignal } from '@temporal-contract/contract';
 * import { z } from 'zod';
 *
 * export const processOrder = defineWorkflow({
 *   input: z.object({ orderId: z.string() }),
 *   output: z.object({ success: z.boolean() }),
 *   // Payment already moved money on success — block a second successful
 *   // run per order. A start is still retryable after a genuinely failed
 *   // attempt (e.g. a declined payment, where no charge went through).
 *   startPolicy: 'retry-if-failed',
 *   activities: {
 *     chargePayment: defineActivity({
 *       input: z.object({ orderId: z.string(), amount: z.number() }),
 *       output: z.object({ transactionId: z.string() }),
 *     }),
 *   },
 *   signals: {
 *     cancel: defineSignal({
 *       input: z.object({ reason: z.string() }),
 *     }),
 *   },
 * });
 * ```
 */
export function defineWorkflow<
  TInput extends AnySchema,
  TWorkflow extends AnyWorkflowDefinition & { readonly input: TInput },
>(
  definition: TWorkflow & {
    readonly input: TInput;
    /**
     * Re-stated against the bound input schema (the structural definition
     * types it `never` — see {@link WorkflowDefinition}), so this lambda's
     * parameter is contextually typed as the workflow's validated input.
     */
    readonly workflowId?: (input: StandardSchemaV1.InferOutput<TInput>) => string;
  } & NoExcessKeys<TWorkflow, AnyWorkflowDefinition>,
): TWorkflow {
  return definition;
}

/**
 * Define a complete Temporal contract with type-safe workflows and activities.
 *
 * A contract is the central definition that ties together your Temporal application's
 * workflows and activities. It provides:
 * - Type safety across client, worker, and workflow code
 * - Automatic validation at runtime
 * - Compile-time verification of implementations
 * - Clear API boundaries and documentation
 *
 * The contract validates the structure and ensures:
 * - Task queue is specified, trimmed, and within Temporal's length limit
 * - At least one workflow or global activity is defined (a contract with
 *   only global `activities` and zero workflows is valid — e.g. a dedicated
 *   activity-pool task queue)
 * - No unknown keys on the contract or on any definition in it (typo
 *   protection)
 * - Every workflow declares a valid `startPolicy`
 * - Valid JavaScript identifiers that don't collide with `Object.prototype`
 *   members, Temporal-reserved names, Temporal system search attributes, or
 *   the worker's own failure types are used
 * - No ambiguous name collisions between workflows, global activities, and
 *   workflow-specific activities (referencing the *same* activity definition
 *   object from several scopes is allowed), and no search attribute declared
 *   with two different kinds
 * - Durations and retry policies are ones Temporal accepts
 * - All schemas implement the Standard Schema specification
 *
 * @template TContract - The contract definition type
 * @param definition - The complete contract definition
 * @returns The same definition with preserved types for type inference
 * @throws {ContractDefinitionError} If the contract structure is invalid
 *
 * **Composition-first.** Define resources individually with `defineActivity`
 * / `defineWorkflow` (and friends), then reference them here — don't inline
 * definitions in `defineContract`. Named resources are reusable across
 * workflows and contracts, get precise hover/jump-to-definition, and keep
 * the contract itself a readable table of contents.
 *
 * @example
 * ```typescript
 * import { defineActivity, defineContract, defineWorkflow } from '@temporal-contract/contract';
 * import { z } from 'zod';
 *
 * // Define resources first...
 * const chargePayment = defineActivity({
 *   input: z.object({ amount: z.number() }),
 *   output: z.object({ transactionId: z.string() }),
 * });
 *
 * const logEvent = defineActivity({
 *   input: z.object({ message: z.string() }),
 *   output: z.void(),
 * });
 *
 * const processOrder = defineWorkflow({
 *   input: z.object({ orderId: z.string() }),
 *   output: z.object({ success: z.boolean() }),
 *   // Payment already moved money on success — block a second successful
 *   // run per order. A start is still retryable after a genuinely failed
 *   // attempt (e.g. a declined payment, where no charge went through).
 *   startPolicy: 'retry-if-failed',
 *   activities: { chargePayment },
 * });
 *
 * // ...then compose the contract from references.
 * export const myContract = defineContract({
 *   taskQueue: 'orders',
 *   workflows: { processOrder },
 *   // Optional global activities shared across workflows
 *   activities: { logEvent },
 * });
 * ```
 */
export function defineContract<TContract extends ContractDefinition>(
  definition: TContract,
): TContract {
  // Validate the entire contract structure (including name collisions)
  validateContractDefinition(definition);
  return definition;
}

/**
 * Check if a value is a Standard Schema compatible schema
 */
function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  // Standard Schema can be either an object or a function (e.g., ArkType)
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null ||
    !("~standard" in value)
  ) {
    return false;
  }

  const standard = (value as Record<string, unknown>)["~standard"];

  return (
    typeof standard === "object" &&
    standard !== null &&
    (standard as Record<string, unknown>)["version"] === 1 &&
    typeof (standard as Record<string, unknown>)["validate"] === "function"
  );
}

/**
 * The materialized `input` schema for input-less signal/query/update
 * definitions (see {@link UndefinedInputSchema}). Accepts only an absent
 * payload — `undefined`, plus `null` defensively, because JSON-based payload
 * converters cannot represent `undefined` and may round-trip it as `null` —
 * and always yields `undefined`.
 */
const undefinedInputSchema: UndefinedInputSchema = {
  "~standard": {
    version: 1,
    vendor: "temporal-contract",
    validate: (value: unknown): StandardSchemaV1.Result<undefined> =>
      value === undefined || value === null
        ? { value: undefined }
        : {
            issues: [{ message: "expected no payload (this definition declares no input schema)" }],
          },
  },
};

/*
 * STRUCTURAL CONTRACT VALIDATION
 *
 * Hand-rolled over `unknown` rather than delegated to a schema library:
 * TypeScript already rejects wrong shapes for typed callers, but a JavaScript
 * caller (or a cast) can pass misspelled keys or non-schema values that would
 * otherwise be silently ignored until a worker or client trips over them.
 * Validation is first-failure-wins: every helper throws a single
 * {@link ContractDefinitionError} whose `path` names the offending slot
 * (dotted, from the contract root — e.g. `workflows.processOrder.signals.cancel`).
 */

/**
 * Thrown by `defineContract` when the contract definition is structurally
 * invalid. `path` locates the offending slot in dotted notation from the
 * contract root (`workflows.processOrder.activities.charge.activityOptions`);
 * it is `""` for root-level failures.
 *
 * A plain `Error` subclass rather than an unthrown `TaggedError`: the package
 * root must stay importable without the optional `unthrown` peer, and an
 * invalid contract is a programming error that aborts at import time anyway.
 */
export class ContractDefinitionError extends Error {
  override readonly name = "ContractDefinitionError";
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.path = path;
  }
}

/**
 * Contract names (workflow, activity, signal, query, update, search
 * attribute, and error names) must be valid JavaScript identifiers — they
 * become property accesses on typed maps.
 * Allows: letters, digits, underscore, dollar sign
 * Must start with: letter, underscore, or dollar sign
 */
const IDENTIFIER_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/**
 * `Object.prototype` member names (`constructor`, `toString`, `__proto__`, …).
 * They pass {@link IDENTIFIER_PATTERN}, but every runtime lookup-by-name on a
 * plain object would resolve them through the prototype chain, so they are
 * rejected for every kind of contract name.
 */
const OBJECT_PROTOTYPE_NAMES: readonly string[] = Object.getOwnPropertyNames(Object.prototype);

/**
 * Temporal reserves handler names for its own SDK internals: everything
 * starting with `__temporal_` plus the exact query names `__stack_trace`
 * and `__enhanced_stack_trace`. A contract resource shadowing one of these
 * would clash with the SDK's built-in handlers at runtime, so they are
 * rejected for workflows, activities, signals, queries, and updates (error
 * and search-attribute names never become Temporal handler names).
 */
const TEMPORAL_RESERVED_PREFIX = "__temporal_";
const TEMPORAL_RESERVED_NAMES: readonly string[] = ["__stack_trace", "__enhanced_stack_trace"];

/** The identifier kinds whose names surface as Temporal handler/type names. */
const TEMPORAL_NAMED_KINDS: readonly string[] = [
  "workflow",
  "activity",
  "global activity",
  "signal",
  "query",
  "update",
];

/**
 * `ApplicationFailure.type` strings the worker emits for its own failures —
 * the `ValidationError` subclasses in `packages/worker/src/errors.ts`. A
 * declared error with one of these names would be indistinguishable on the
 * wire (and in `nonRetryableErrorTypes`) from the worker's own failure. Keep
 * in sync with that file.
 */
const WORKER_FAILURE_TYPES: readonly string[] = [
  "ActivityInputValidationError",
  "ActivityOutputValidationError",
  "WorkflowInputValidationError",
  "WorkflowOutputValidationError",
  "QueryInputValidationError",
  "QueryOutputValidationError",
  "UpdateInputValidationError",
  "UpdateOutputValidationError",
  "ContractErrorDataValidationError",
  "ContractMisuseError",
];

/**
 * Temporal's built-in system search attributes. Declaring a custom attribute
 * under one of these names is rejected by the server when the workflow
 * starts, so it is rejected at definition time instead.
 */
const TEMPORAL_SYSTEM_SEARCH_ATTRIBUTES: readonly string[] = [
  "WorkflowType",
  "WorkflowId",
  "RunId",
  "ExecutionStatus",
  "TaskQueue",
  "StartTime",
  "CloseTime",
  "ExecutionTime",
  "ExecutionDuration",
  "HistoryLength",
  "HistorySizeBytes",
  "StateTransitionCount",
  "TemporalChangeVersion",
  "BinaryChecksums",
  "BuildIds",
  "BatcherUser",
  "TemporalScheduledStartTime",
  "TemporalScheduledById",
  "TemporalSchedulePaused",
  "TemporalNamespaceDivision",
  "ParentWorkflowId",
  "ParentRunId",
  "RootWorkflowId",
  "RootRunId",
];

/** Temporal's default maximum length for IDs, task queue names included (`limit.maxIDLength`). */
const MAX_TASK_QUEUE_LENGTH = 1000;

/** The seven Temporal search attribute kinds (see {@link SearchAttributeKind}). */
const SEARCH_ATTRIBUTE_KINDS: readonly string[] = [
  "TEXT",
  "KEYWORD",
  "INT",
  "DOUBLE",
  "BOOL",
  "DATETIME",
  "KEYWORD_LIST",
];

const START_POLICIES: readonly string[] = ["once-per-id", "retry-if-failed", "allow-duplicate"];

const CONTRACT_KEYS = ["taskQueue", "workflows", "activities"] as const;

const WORKFLOW_KEYS = [
  "input",
  "output",
  "workflowId",
  "startPolicy",
  "activities",
  "signals",
  "queries",
  "updates",
  "searchAttributes",
  "errors",
] as const;

const ACTIVITY_KEYS = ["input", "output", "errors", "activityOptions", "idempotencyKey"] as const;

const ERROR_KEYS = ["data", "message", "nonRetryable"] as const;

const ACTIVITY_OPTIONS_KEYS = [
  "startToCloseTimeout",
  "scheduleToCloseTimeout",
  "scheduleToStartTimeout",
  "heartbeatTimeout",
  "retry",
] as const;

const ACTIVITY_OPTIONS_DURATION_KEYS = [
  "startToCloseTimeout",
  "scheduleToCloseTimeout",
  "scheduleToStartTimeout",
  "heartbeatTimeout",
] as const;

const RETRY_KEYS = [
  "initialInterval",
  "maximumInterval",
  "backoffCoefficient",
  "maximumAttempts",
  "nonRetryableErrorTypes",
] as const;

/** Throw the canonical single-line contract validation error. */
function fail(path: string, detail: string): never {
  // oxlint-disable-next-line unthrown/no-throw -- declaration-time fail-fast config error: an invalid contract must abort at definition, before any Result seam exists
  throw new ContractDefinitionError(
    path,
    `Contract validation failed${path ? ` at ${path}` : ""}: ${detail}`,
  );
}

/** Plain-object check — `null` and arrays don't qualify as definition maps. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertIdentifier(kind: string, name: string, path: string): void {
  if (!IDENTIFIER_PATTERN.test(name)) {
    fail(path, `${kind} name "${name}" must be a valid JavaScript identifier`);
  }
  if (OBJECT_PROTOTYPE_NAMES.includes(name)) {
    fail(
      path,
      `${kind} name "${name}" is an Object.prototype member — name-keyed lookups would resolve it through the prototype chain. Rename it.`,
    );
  }
  if (
    TEMPORAL_NAMED_KINDS.includes(kind) &&
    (name.startsWith(TEMPORAL_RESERVED_PREFIX) || TEMPORAL_RESERVED_NAMES.includes(name))
  ) {
    fail(
      path,
      `${kind} name "${name}" is reserved by Temporal — names starting with "__temporal_" and the names "__stack_trace" / "__enhanced_stack_trace" are used internally by the Temporal SDK. Rename it.`,
    );
  }
  if (kind === "error" && WORKER_FAILURE_TYPES.includes(name)) {
    fail(
      path,
      `error name "${name}" is reserved — the worker emits it as the ApplicationFailure type of its own failures. Rename it.`,
    );
  }
  if (kind === "search attribute" && TEMPORAL_SYSTEM_SEARCH_ATTRIBUTES.includes(name)) {
    fail(path, `search attribute name "${name}" is a Temporal system search attribute. Rename it.`);
  }
}

/**
 * Reject unknown keys on a strict bag, listing both the offending and the
 * allowed keys so a typo is a one-glance fix.
 */
function assertKnownKeys(
  path: string,
  bag: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(bag).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    const offending = unknown.map((key) => `"${key}"`).join(", ");
    const expected = allowed.map((key) => `"${key}"`).join(", ");
    fail(
      path,
      `unknown key${unknown.length > 1 ? "s" : ""} ${offending} — allowed keys are ${expected}`,
    );
  }
}

function assertSchema(path: string, slot: string, value: unknown): void {
  if (!isStandardSchema(value)) {
    fail(
      `${path}.${slot}`,
      `${slot} must be a Standard Schema compatible schema (e.g., Zod, Valibot, ArkType)`,
    );
  }
}

function assertOptionalFunction(path: string, slot: string, value: unknown): void {
  if (value !== undefined && typeof value !== "function") {
    fail(`${path}.${slot}`, `${slot} must be a function`);
  }
}

/**
 * Strict grammar of the `ms` npm package (which Temporal uses to parse
 * duration strings): a decimal number followed by an optional unit —
 * `ms`/`s`/`m`/`h`/`d`/`w`/`y`, their long forms (`msecs`, `seconds`,
 * `mins`, `hours`, `days`, `weeks`, `yrs`, …), with optional spaces before
 * the unit. A bare number string ("1500") means milliseconds, exactly as
 * `ms` treats it. The `ms` grammar technically accepts a leading `-`, but a
 * negative duration is never a valid Temporal timeout/interval, so the sign
 * is deliberately rejected here.
 */
const MS_DURATION_PATTERN =
  /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i;

/**
 * Milliseconds per unit, keyed by the unit's first letter — `ms`'s own
 * factors (a year is 365.25 days). Millisecond units (`ms`, `msecs`,
 * `milliseconds`) also start with `m` and are special-cased before lookup.
 */
const MS_PER_UNIT: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_557_600_000,
};

/**
 * Validate a Temporal duration value — an `ms`-formatted string or a
 * non-negative finite number of milliseconds — and return it in
 * milliseconds. `undefined` (absent) is allowed and returned as-is — every
 * duration slot on the contract-level `activityOptions` is optional.
 *
 * Strings are validated against the `ms` grammar at `defineContract` time so
 * a malformed duration ("5 minutos") fails when the contract is defined —
 * with a message naming the offending path — instead of surfacing later as
 * an opaque worker-side Temporal error.
 */
function parseDuration(path: string, key: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      fail(
        `${path}.${key}`,
        `${key} has invalid duration ${String(value)} — a numeric duration must be a non-negative, finite number of milliseconds`,
      );
    }
    return value;
  }
  if (typeof value !== "string") {
    fail(`${path}.${key}`, `${key} must be an ms-formatted string or a number of milliseconds`);
  }
  // Cheap length cap first: the regex is linear, but there is no reason to
  // run it over an arbitrarily long string when the cap rejects it anyway.
  const match = value.length > 100 ? null : MS_DURATION_PATTERN.exec(value);
  if (!match) {
    fail(
      `${path}.${key}`,
      `${key} has invalid duration "${value}" — expected an ms-formatted string (a number followed by an optional unit ms/s/m/h/d/w/y or its long form, e.g. "30s", "5 minutes", "1.5h") or a number of milliseconds`,
    );
  }
  const unit = match[2]?.toLowerCase();
  const factor =
    unit === undefined || unit.startsWith("ms") || unit.startsWith("milli")
      ? 1
      : (MS_PER_UNIT[unit.charAt(0)] ?? 1);
  return Number(match[1]) * factor;
}

/**
 * Validate an `errors` map: identifier keys (not colliding with the worker's
 * own failure types), and per entry strict keys, an optional
 * Standard Schema `data` (like every other schema slot on the contract),
 * string `message`, and boolean `nonRetryable`.
 */
function validateErrorsMap(path: string, errors: unknown): void {
  const errorsPath = `${path}.errors`;
  if (!isRecord(errors)) {
    fail(errorsPath, "errors must be an object");
  }
  for (const [errorName, definition] of Object.entries(errors)) {
    const errorPath = `${errorsPath}.${errorName}`;
    assertIdentifier("error", errorName, errorPath);
    if (!isRecord(definition)) {
      fail(errorPath, "error definition must be an object");
    }
    assertKnownKeys(errorPath, definition, ERROR_KEYS);
    if (definition["data"] !== undefined) {
      assertSchema(errorPath, "data", definition["data"]);
    }
    if (definition["message"] !== undefined && typeof definition["message"] !== "string") {
      fail(`${errorPath}.message`, "message must be a string");
    }
    if (
      definition["nonRetryable"] !== undefined &&
      typeof definition["nonRetryable"] !== "boolean"
    ) {
      fail(`${errorPath}.nonRetryable`, "nonRetryable must be a boolean");
    }
  }
}

/**
 * Validate contract-level `activityOptions`. Strict keys so a typo
 * (`startToCloseTimeOut`) fails at `defineContract` time instead of being
 * silently ignored when the worker merges options.
 *
 * The retry policy mirrors `@temporalio/common`'s `compileRetryPolicy` (plus
 * the server's `backoffCoefficient >= 1` rule): an invalid policy otherwise
 * only throws inside the workflow when the activity is scheduled, failing the
 * workflow task on every attempt instead of failing here.
 */
function validateActivityOptions(path: string, options: unknown): void {
  const optionsPath = `${path}.activityOptions`;
  if (!isRecord(options)) {
    fail(optionsPath, "activityOptions must be an object");
  }
  assertKnownKeys(optionsPath, options, ACTIVITY_OPTIONS_KEYS);
  for (const key of ACTIVITY_OPTIONS_DURATION_KEYS) {
    parseDuration(optionsPath, key, options[key]);
  }

  const retry = options["retry"];
  if (retry === undefined) return;
  const retryPath = `${optionsPath}.retry`;
  if (!isRecord(retry)) {
    fail(retryPath, "retry must be an object");
  }
  assertKnownKeys(retryPath, retry, RETRY_KEYS);
  const initialInterval = parseDuration(retryPath, "initialInterval", retry["initialInterval"]);
  const maximumInterval = parseDuration(retryPath, "maximumInterval", retry["maximumInterval"]);
  if (initialInterval === 0) {
    fail(`${retryPath}.initialInterval`, "initialInterval cannot be 0");
  }
  if (maximumInterval === 0) {
    fail(`${retryPath}.maximumInterval`, "maximumInterval cannot be 0");
  }
  // Temporal compares against its 1s default when `initialInterval` is absent.
  if (maximumInterval !== undefined && maximumInterval < (initialInterval ?? 1000)) {
    fail(
      `${retryPath}.maximumInterval`,
      `maximumInterval cannot be less than initialInterval (${initialInterval ?? "1000, Temporal's default"} ms)`,
    );
  }
  const backoffCoefficient = retry["backoffCoefficient"];
  if (
    backoffCoefficient !== undefined &&
    (typeof backoffCoefficient !== "number" ||
      !Number.isFinite(backoffCoefficient) ||
      backoffCoefficient < 1)
  ) {
    fail(`${retryPath}.backoffCoefficient`, "backoffCoefficient must be a finite number >= 1");
  }
  const maximumAttempts = retry["maximumAttempts"];
  if (
    maximumAttempts !== undefined &&
    maximumAttempts !== Number.POSITIVE_INFINITY &&
    !(Number.isInteger(maximumAttempts) && (maximumAttempts as number) > 0)
  ) {
    fail(
      `${retryPath}.maximumAttempts`,
      "maximumAttempts must be a positive integer, or Infinity for unlimited attempts",
    );
  }
  const nonRetryableErrorTypes = retry["nonRetryableErrorTypes"];
  if (
    nonRetryableErrorTypes !== undefined &&
    (!Array.isArray(nonRetryableErrorTypes) ||
      nonRetryableErrorTypes.some((entry) => typeof entry !== "string"))
  ) {
    fail(
      `${retryPath}.nonRetryableErrorTypes`,
      "nonRetryableErrorTypes must be an array of strings",
    );
  }
}

/**
 * Validate an activity definition: strict keys, Standard Schema
 * `input`/`output`, plus optional `errors`, `activityOptions`, and
 * `idempotencyKey`.
 */
function validateActivityDefinition(path: string, definition: unknown): void {
  if (!isRecord(definition)) {
    fail(path, "activity definition must be an object");
  }
  if (definition["defaultOptions"] !== undefined) {
    fail(
      `${path}.defaultOptions`,
      `"defaultOptions" was renamed to "activityOptions". Rename the field (the options are unchanged).`,
    );
  }
  assertKnownKeys(path, definition, ACTIVITY_KEYS);
  assertSchema(path, "input", definition["input"]);
  assertSchema(path, "output", definition["output"]);
  assertOptionalFunction(path, "idempotencyKey", definition["idempotencyKey"]);
  if (definition["errors"] !== undefined) {
    validateErrorsMap(path, definition["errors"]);
  }
  if (definition["activityOptions"] !== undefined) {
    validateActivityOptions(path, definition["activityOptions"]);
  }
}

/**
 * Validate a signal (`input` only), query, or update (`input` + `output`)
 * definition. `defineSignal`/`defineQuery`/`defineUpdate` materialize
 * {@link undefinedInputSchema} when `input` is omitted, so by the time a
 * definition reaches `defineContract` its `input` slot is always present.
 */
function validateMessageDefinition(path: string, definition: unknown, hasOutput: boolean): void {
  if (!isRecord(definition)) {
    fail(path, "definition must be an object");
  }
  assertKnownKeys(path, definition, hasOutput ? ["input", "output"] : ["input"]);
  assertSchema(path, "input", definition["input"]);
  if (hasOutput) {
    assertSchema(path, "output", definition["output"]);
  }
}

/** Validate a search attribute definition: `kind` must be one of the seven Temporal kinds. */
function validateSearchAttributeDefinition(path: string, definition: unknown): void {
  if (!isRecord(definition)) {
    fail(path, "search attribute definition must be an object");
  }
  assertKnownKeys(path, definition, ["kind"]);
  const kind = definition["kind"];
  if (typeof kind !== "string" || !SEARCH_ATTRIBUTE_KINDS.includes(kind)) {
    const expected = SEARCH_ATTRIBUTE_KINDS.map((entry) => `"${entry}"`).join(", ");
    fail(`${path}.kind`, `kind must be one of ${expected}`);
  }
}

/**
 * Walk an optional `Record<name, definition>` slot of a workflow: the slot
 * must be a plain object, every key a valid identifier, every value valid
 * per `validateEntry`.
 */
function validateDefinitionMap(
  path: string,
  slot: string,
  kind: string,
  map: unknown,
  validateEntry: (entryPath: string, definition: unknown) => void,
): void {
  if (map === undefined) return;
  const slotPath = `${path}.${slot}`;
  if (!isRecord(map)) {
    fail(slotPath, `${slot} must be an object`);
  }
  for (const [name, definition] of Object.entries(map)) {
    const entryPath = `${slotPath}.${name}`;
    assertIdentifier(kind, name, entryPath);
    validateEntry(entryPath, definition);
  }
}

/**
 * Validate a workflow definition: strict keys, Standard Schema
 * `input`/`output`, a required `startPolicy`, an optional `workflowId`
 * function, plus the optional
 * activities/signals/queries/updates/searchAttributes/errors maps.
 */
function validateWorkflowDefinition(path: string, definition: unknown): void {
  if (!isRecord(definition)) {
    fail(path, "workflow definition must be an object");
  }
  // A definition still carrying the pre-rename `idempotency` field fails
  // with a pointed message rather than the generic unknown-key one.
  if (definition["idempotency"] !== undefined) {
    fail(
      `${path}.idempotency`,
      `"idempotency" was renamed to "startPolicy". Rename the field (the mode values are unchanged).`,
    );
  }
  assertKnownKeys(path, definition, WORKFLOW_KEYS);
  assertSchema(path, "input", definition["input"]);
  assertSchema(path, "output", definition["output"]);
  assertOptionalFunction(path, "workflowId", definition["workflowId"]);
  // Required at runtime too, so the client and worker can rely on it: a
  // definition assembled outside the type system would otherwise silently
  // inherit Temporal's `ALLOW_DUPLICATE`.
  const startPolicy = definition["startPolicy"];
  if (typeof startPolicy !== "string" || !START_POLICIES.includes(startPolicy)) {
    fail(
      `${path}.startPolicy`,
      `startPolicy is required and must be "once-per-id", "retry-if-failed", or "allow-duplicate"`,
    );
  }
  validateDefinitionMap(
    path,
    "activities",
    "activity",
    definition["activities"],
    validateActivityDefinition,
  );
  validateDefinitionMap(path, "signals", "signal", definition["signals"], (entryPath, entry) =>
    validateMessageDefinition(entryPath, entry, false),
  );
  validateDefinitionMap(path, "queries", "query", definition["queries"], (entryPath, entry) =>
    validateMessageDefinition(entryPath, entry, true),
  );
  validateDefinitionMap(path, "updates", "update", definition["updates"], (entryPath, entry) =>
    validateMessageDefinition(entryPath, entry, true),
  );
  validateDefinitionMap(
    path,
    "searchAttributes",
    "search attribute",
    definition["searchAttributes"],
    validateSearchAttributeDefinition,
  );
  if (definition["errors"] !== undefined) {
    validateErrorsMap(path, definition["errors"]);
  }
}

/**
 * Cross-cutting name-collision checks that the per-definition walk can't see.
 *
 * 1. Workflow names vs **global** activity names: at the worker, workflow
 *    implementations and global activity implementations share the root of
 *    the same implementations map, so a shared name is ambiguous.
 * 2. Activity names across scopes: activities are registered in a single
 *    flat namespace at runtime, so a duplicate name silently clobbers
 *    another — unless every scope references the *same* definition object
 *    (a shared `defineActivity` result), which flattens unambiguously and
 *    is therefore allowed.
 * 3. Search attribute names across workflows: Temporal registers a search
 *    attribute once per namespace with a single type, so the same name
 *    declared with different kinds can't both be right.
 */
function validateNameCollisions(
  workflows: Record<string, unknown>,
  globalActivities: Record<string, unknown> | undefined,
): void {
  if (globalActivities) {
    for (const activityName of Object.keys(globalActivities)) {
      if (Object.hasOwn(workflows, activityName)) {
        fail(
          `activities.${activityName}`,
          `global activity "${activityName}" has the same name as a workflow. Workflows and global activities share the root of the worker implementations map — rename one of them.`,
        );
      }
    }
  }

  // The global owner is tracked with a Symbol rather than a sentinel string
  // because workflow names are only validated as JS identifiers — a user
  // could legitimately name a workflow "global", and a string sentinel would
  // misclassify those collisions.
  const GLOBAL_OWNER: unique symbol = Symbol("global");
  type Owner = { name: string | typeof GLOBAL_OWNER; definition: unknown };
  const owners = new Map<string, Owner>();

  if (globalActivities) {
    for (const [activityName, definition] of Object.entries(globalActivities)) {
      owners.set(activityName, { name: GLOBAL_OWNER, definition });
    }
  }

  // Structural validation already ran, so present slots are plain objects of
  // valid definitions.
  const searchAttributeKinds = new Map<string, { kind: unknown; workflowName: string }>();
  for (const [workflowName, workflow] of Object.entries(workflows)) {
    const { activities: workflowActivities, searchAttributes } = workflow as {
      activities?: Record<string, unknown>;
      searchAttributes?: Record<string, { kind: unknown }>;
    };
    for (const [name, { kind }] of Object.entries(searchAttributes ?? {})) {
      const previous = searchAttributeKinds.get(name);
      if (previous && previous.kind !== kind) {
        fail(
          `workflows.${workflowName}.searchAttributes.${name}`,
          `search attribute "${name}" is declared as ${String(kind)} here but as ${String(previous.kind)} in workflow "${previous.workflowName}". A search attribute has one type per namespace — use the same kind or rename one of them.`,
        );
      }
      searchAttributeKinds.set(name, { kind, workflowName });
    }

    for (const [activityName, definition] of Object.entries(workflowActivities ?? {})) {
      const previousOwner = owners.get(activityName);
      if (!previousOwner) {
        owners.set(activityName, { name: workflowName, definition });
        continue;
      }
      if (previousOwner.definition === definition) {
        // Same definition object in both scopes — the flat namespace stays
        // unambiguous, so sharing one `defineActivity` result is allowed.
        continue;
      }
      const activityPath = `workflows.${workflowName}.activities.${activityName}`;
      if (previousOwner.name === GLOBAL_OWNER) {
        fail(
          activityPath,
          `workflow "${workflowName}" has activity "${activityName}" that conflicts with a different global activity of the same name. Activities share a single flat namespace at runtime — reference the shared definition from the contract's global "activities" block, or rename one of them.`,
        );
      }
      fail(
        activityPath,
        `workflow "${workflowName}" has activity "${activityName}" that conflicts with a different same-named activity in workflow "${previousOwner.name}". Activities share a single flat namespace at runtime — hoist the shared activity to the contract's global "activities" block, or rename one of them.`,
      );
    }
  }
}

/**
 * Validate a contract definition's structure. The root is strict — an
 * unknown top-level key (e.g. a misspelled `workflow`) fails instead of
 * being silently ignored, like every definition below it.
 */
function validateContractDefinition(definition: unknown): void {
  if (!isRecord(definition)) {
    fail("", "contract must be an object");
  }
  assertKnownKeys("", definition, CONTRACT_KEYS);

  const taskQueue = definition["taskQueue"];
  if (typeof taskQueue !== "string") {
    fail("taskQueue", "taskQueue must be a string");
  }
  if (taskQueue.trim().length === 0) {
    fail("taskQueue", "taskQueue cannot be empty");
  }
  if (taskQueue.trim() !== taskQueue) {
    fail("taskQueue", "taskQueue cannot have leading or trailing whitespace");
  }
  if (taskQueue.length > MAX_TASK_QUEUE_LENGTH) {
    fail(
      "taskQueue",
      `taskQueue cannot exceed ${MAX_TASK_QUEUE_LENGTH} characters (Temporal's default limit)`,
    );
  }

  const workflows = definition["workflows"];
  if (!isRecord(workflows)) {
    fail("workflows", "workflows must be an object");
  }
  for (const [workflowName, workflow] of Object.entries(workflows)) {
    const workflowPath = `workflows.${workflowName}`;
    assertIdentifier("workflow", workflowName, workflowPath);
    validateWorkflowDefinition(workflowPath, workflow);
  }

  const activities = definition["activities"];
  if (activities !== undefined && !isRecord(activities)) {
    fail("activities", "activities must be an object");
  }
  if (activities) {
    for (const [activityName, activity] of Object.entries(activities)) {
      const activityPath = `activities.${activityName}`;
      assertIdentifier("global activity", activityName, activityPath);
      validateActivityDefinition(activityPath, activity);
    }
  }

  // Activity-only contracts (zero workflows, ≥1 global activity) are valid —
  // they model dedicated activity-pool task queues. A contract with neither
  // workflows nor activities declares nothing and is still rejected.
  if (Object.keys(workflows).length === 0 && Object.keys(activities ?? {}).length === 0) {
    fail("", "at least one workflow or global activity is required");
  }

  validateNameCollisions(workflows, activities);
}
