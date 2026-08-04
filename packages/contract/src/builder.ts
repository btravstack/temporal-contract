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
import type { ValidateContract } from "./validate-contract.js";

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
export function defineActivity<TActivity extends ActivityDefinition>(
  definition: TActivity,
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
export function defineSignal<TSignal extends SignalDefinition>(definition: TSignal): TSignal;
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
export function defineQuery<TQuery extends QueryDefinition>(definition: TQuery): TQuery;
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
export function defineUpdate<TUpdate extends UpdateDefinition>(definition: TUpdate): TUpdate;
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
 *   activities: {
 *     validatePayment: defineActivity({
 *       input: z.object({ orderId: z.string() }),
 *       output: z.object({ valid: z.boolean() }),
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
export function defineWorkflow<TWorkflow extends AnyWorkflowDefinition>(
  definition: TWorkflow,
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
 * - Task queue is specified
 * - At least one workflow or global activity is defined (a contract with
 *   only global `activities` and zero workflows is valid — e.g. a dedicated
 *   activity-pool task queue)
 * - No unknown top-level keys (typo protection, like `activityOptions`)
 * - Valid JavaScript identifiers that don't collide with Temporal-reserved
 *   names are used
 * - No ambiguous name collisions between workflows, global activities, and
 *   workflow-specific activities (referencing the *same* activity definition
 *   object from several scopes is allowed)
 * - All schemas implement the Standard Schema specification
 *
 * @template TContract - The contract definition type
 * @param definition - The complete contract definition
 * @returns The same definition with preserved types for type inference
 * @throws {Error} If the contract structure is invalid
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
export function defineContract<const TContract extends ContractDefinition>(
  definition: ValidateContract<TContract>,
): TContract;
// `const` here (and only here — the implementation signature below is
// deliberately not `const`, see its own comment) is load-bearing, not
// decorative. Without it, a duration literal written *inline* inside this
// call — `defineContract({ …, activityOptions: { startToCloseTimeout:
// "5 minutos" } })` — has no separate call whose constraint (`TActivity
// extends ActivityDefinition`) preserves it: `defineContract`'s own
// constraint (`ContractDefinition` → `ContractActivityOptions` →
// `DurationValue`) is the only thing inference can lean on, and without
// `const` that constraint-derived contextual type is what wins, widening
// the literal to plain `string` before `ValidateContract` ever sees it.
// `CheckDuration`'s `string extends V` branch then treats it as the
// legitimate computed-value case and passes it through unchecked — a
// silent gap. `const` makes literal inference win over the constraint for
// this call specifically, so the inline case is checked the same way the
// separate-`defineActivity` path already is.
// Implementation signature only — not part of the public call surface (a
// signature with a body never is, once a separate overload signature
// exists above it). It exists purely so the body below type-checks:
// `ValidateContract<TContract>` is a mapped/conditional type over
// `TContract`, and `exactOptionalPropertyTypes` makes `return definition`
// unprovable against the generic `TContract` return type (TS2375) even
// though every concrete instantiation is sound. Typing this internal
// signature identity-style (`TContract` in, `TContract` out) sidesteps
// that without touching what callers see or what the body does.
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
 * Validation is first-failure-wins: every helper throws a single-line
 * `Contract validation failed: …` error naming the offending path.
 */

/**
 * Contract names (workflow, activity, signal, query, update, search
 * attribute, and error names) must be valid JavaScript identifiers — they
 * become property accesses on typed maps.
 * Allows: letters, digits, underscore, dollar sign
 * Must start with: letter, underscore, or dollar sign
 */
const IDENTIFIER_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

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
function fail(detail: string): never {
  // oxlint-disable-next-line unthrown/no-throw -- declaration-time fail-fast config error: an invalid contract must abort at definition, before any Result seam exists
  throw new Error(`Contract validation failed: ${detail}`);
}

/** Plain-object check — `null` and arrays don't qualify as definition maps. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertIdentifier(kind: string, name: string): void {
  if (!IDENTIFIER_PATTERN.test(name)) {
    fail(`${kind} name "${name}" must be a valid JavaScript identifier`);
  }
  if (
    TEMPORAL_NAMED_KINDS.includes(kind) &&
    (name.startsWith(TEMPORAL_RESERVED_PREFIX) || TEMPORAL_RESERVED_NAMES.includes(name))
  ) {
    fail(
      `${kind} name "${name}" is reserved by Temporal — names starting with "__temporal_" and the names "__stack_trace" / "__enhanced_stack_trace" are used internally by the Temporal SDK. Rename it.`,
    );
  }
}

/**
 * Reject unknown keys on a strict bag, listing both the offending and the
 * allowed keys so a typo is a one-glance fix.
 */
function assertKnownKeys(
  context: string,
  bag: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(bag).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    const offending = unknown.map((key) => `"${key}"`).join(", ");
    const expected = allowed.map((key) => `"${key}"`).join(", ");
    fail(
      `${context} has unknown key${unknown.length > 1 ? "s" : ""} ${offending} — allowed keys are ${expected}`,
    );
  }
}

function assertSchema(context: string, slot: string, value: unknown): void {
  if (!isStandardSchema(value)) {
    fail(
      `${context}: ${slot} must be a Standard Schema compatible schema (e.g., Zod, Valibot, ArkType)`,
    );
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
  /^(?:\d+)?\.?\d+ *(?:milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i;

/**
 * A Temporal duration value: an `ms`-formatted string or a non-negative
 * finite number of milliseconds. `undefined` (absent) is allowed — every
 * duration slot on the contract-level `activityOptions` is optional.
 *
 * Strings are validated against the `ms` grammar at `defineContract` time so
 * a malformed duration ("5 minutos") fails when the contract is defined —
 * with a message naming the offending path — instead of surfacing later as
 * an opaque worker-side Temporal error.
 */
function assertDuration(context: string, key: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      fail(
        `${context}: ${key} has invalid duration ${String(value)} — a numeric duration must be a non-negative, finite number of milliseconds`,
      );
    }
    return;
  }
  if (typeof value !== "string") {
    fail(`${context}: ${key} must be an ms-formatted string or a number of milliseconds`);
  }
  // Cheap length cap first: the regex is linear, but there is no reason to
  // run it over an arbitrarily long string when the cap rejects it anyway.
  if (value.length > 100 || !MS_DURATION_PATTERN.test(value)) {
    fail(
      `${context}: ${key} has invalid duration "${value}" — expected an ms-formatted string (a number followed by an optional unit ms/s/m/h/d/w/y or its long form, e.g. "30s", "5 minutes", "1.5h") or a number of milliseconds`,
    );
  }
}

/**
 * Validate an `errors` map: identifier keys, and per entry an optional
 * Standard Schema `data` (like every other schema slot on the contract),
 * string `message`, and boolean `nonRetryable`.
 */
function validateErrorsMap(context: string, errors: unknown): void {
  if (!isRecord(errors)) {
    fail(`${context}: errors must be an object`);
  }
  for (const [errorName, definition] of Object.entries(errors)) {
    assertIdentifier("error", errorName);
    const errorContext = `${context} error "${errorName}"`;
    if (!isRecord(definition)) {
      fail(`${errorContext} must be an object`);
    }
    if (definition["data"] !== undefined) {
      assertSchema(errorContext, "data", definition["data"]);
    }
    if (definition["message"] !== undefined && typeof definition["message"] !== "string") {
      fail(`${errorContext}: message must be a string`);
    }
    if (
      definition["nonRetryable"] !== undefined &&
      typeof definition["nonRetryable"] !== "boolean"
    ) {
      fail(`${errorContext}: nonRetryable must be a boolean`);
    }
  }
}

/**
 * Validate contract-level `activityOptions`. Strict keys so a typo
 * (`startToCloseTimeOut`) fails at `defineContract` time instead of being
 * silently ignored when the worker merges options.
 */
function validateActivityOptions(context: string, options: unknown): void {
  if (!isRecord(options)) {
    fail(`${context}: activityOptions must be an object`);
  }
  assertKnownKeys(`${context} activityOptions`, options, ACTIVITY_OPTIONS_KEYS);
  for (const key of ACTIVITY_OPTIONS_DURATION_KEYS) {
    assertDuration(`${context} activityOptions`, key, options[key]);
  }

  const retry = options["retry"];
  if (retry === undefined) return;
  if (!isRecord(retry)) {
    fail(`${context}: activityOptions.retry must be an object`);
  }
  assertKnownKeys(`${context} activityOptions.retry`, retry, RETRY_KEYS);
  assertDuration(`${context} activityOptions.retry`, "initialInterval", retry["initialInterval"]);
  assertDuration(`${context} activityOptions.retry`, "maximumInterval", retry["maximumInterval"]);
  for (const key of ["backoffCoefficient", "maximumAttempts"] as const) {
    if (retry[key] !== undefined && typeof retry[key] !== "number") {
      fail(`${context}: activityOptions.retry.${key} must be a number`);
    }
  }
  const nonRetryableErrorTypes = retry["nonRetryableErrorTypes"];
  if (
    nonRetryableErrorTypes !== undefined &&
    (!Array.isArray(nonRetryableErrorTypes) ||
      nonRetryableErrorTypes.some((entry) => typeof entry !== "string"))
  ) {
    fail(`${context}: activityOptions.retry.nonRetryableErrorTypes must be an array of strings`);
  }
}

/**
 * Validate an activity definition: Standard Schema `input`/`output`, plus
 * optional `errors` and `activityOptions`.
 */
function validateActivityDefinition(context: string, definition: unknown): void {
  if (!isRecord(definition)) {
    fail(`${context} must be an object`);
  }
  assertSchema(context, "input", definition["input"]);
  assertSchema(context, "output", definition["output"]);
  if (definition["errors"] !== undefined) {
    validateErrorsMap(context, definition["errors"]);
  }
  if (definition["activityOptions"] !== undefined) {
    validateActivityOptions(context, definition["activityOptions"]);
  }
}

/**
 * Validate a signal (`input` only), query, or update (`input` + `output`)
 * definition. `defineSignal`/`defineQuery`/`defineUpdate` materialize
 * {@link undefinedInputSchema} when `input` is omitted, so by the time a
 * definition reaches `defineContract` its `input` slot is always present.
 */
function validateMessageDefinition(context: string, definition: unknown, hasOutput: boolean): void {
  if (!isRecord(definition)) {
    fail(`${context} must be an object`);
  }
  assertSchema(context, "input", definition["input"]);
  if (hasOutput) {
    assertSchema(context, "output", definition["output"]);
  }
}

/** Validate a search attribute definition: `kind` must be one of the seven Temporal kinds. */
function validateSearchAttributeDefinition(context: string, definition: unknown): void {
  if (!isRecord(definition)) {
    fail(`${context} must be an object`);
  }
  const kind = definition["kind"];
  if (typeof kind !== "string" || !SEARCH_ATTRIBUTE_KINDS.includes(kind)) {
    const expected = SEARCH_ATTRIBUTE_KINDS.map((entry) => `"${entry}"`).join(", ");
    fail(`${context}: kind must be one of ${expected}`);
  }
}

/**
 * Walk an optional `Record<name, definition>` slot of a workflow: the slot
 * must be a plain object, every key a valid identifier, every value valid
 * per `validateEntry`.
 */
function validateDefinitionMap(
  context: string,
  slot: string,
  kind: string,
  map: unknown,
  validateEntry: (entryContext: string, definition: unknown) => void,
): void {
  if (map === undefined) return;
  if (!isRecord(map)) {
    fail(`${context}: ${slot} must be an object`);
  }
  for (const [name, definition] of Object.entries(map)) {
    assertIdentifier(kind, name);
    validateEntry(`${context} ${kind} "${name}"`, definition);
  }
}

/**
 * Validate a workflow definition: Standard Schema `input`/`output`, plus the
 * optional activities/signals/queries/updates/searchAttributes/errors maps.
 */
function validateWorkflowDefinition(context: string, definition: unknown): void {
  if (!isRecord(definition)) {
    fail(`${context} must be an object`);
  }
  assertSchema(context, "input", definition["input"]);
  assertSchema(context, "output", definition["output"]);
  const idempotency = definition["idempotency"];
  if (
    idempotency !== undefined &&
    idempotency !== "once-per-id" &&
    idempotency !== "retry-if-failed" &&
    idempotency !== "allow-duplicate"
  ) {
    fail(`${context}: idempotency must be "once-per-id", "retry-if-failed", or "allow-duplicate"`);
  }
  validateDefinitionMap(
    context,
    "activities",
    "activity",
    definition["activities"],
    validateActivityDefinition,
  );
  validateDefinitionMap(
    context,
    "signals",
    "signal",
    definition["signals"],
    (entryContext, entry) => validateMessageDefinition(entryContext, entry, false),
  );
  validateDefinitionMap(context, "queries", "query", definition["queries"], (entryContext, entry) =>
    validateMessageDefinition(entryContext, entry, true),
  );
  validateDefinitionMap(
    context,
    "updates",
    "update",
    definition["updates"],
    (entryContext, entry) => validateMessageDefinition(entryContext, entry, true),
  );
  validateDefinitionMap(
    context,
    "searchAttributes",
    "search attribute",
    definition["searchAttributes"],
    validateSearchAttributeDefinition,
  );
  if (definition["errors"] !== undefined) {
    validateErrorsMap(context, definition["errors"]);
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
 */
function validateNameCollisions(
  workflows: Record<string, unknown>,
  globalActivities: Record<string, unknown> | undefined,
): void {
  if (globalActivities) {
    for (const activityName of Object.keys(globalActivities)) {
      if (Object.hasOwn(workflows, activityName)) {
        fail(
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

  for (const [workflowName, workflow] of Object.entries(workflows)) {
    // Structural validation already ran, so a present `activities` slot is a
    // plain object of definitions.
    const workflowActivities = (workflow as { activities?: unknown }).activities;
    if (!isRecord(workflowActivities)) {
      continue;
    }
    for (const [activityName, definition] of Object.entries(workflowActivities)) {
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
      if (previousOwner.name === GLOBAL_OWNER) {
        fail(
          `workflow "${workflowName}" has activity "${activityName}" that conflicts with a different global activity of the same name. Activities share a single flat namespace at runtime — reference the shared definition from the contract's global "activities" block, or rename one of them.`,
        );
      }
      fail(
        `workflow "${workflowName}" has activity "${activityName}" that conflicts with a different same-named activity in workflow "${previousOwner.name}". Activities share a single flat namespace at runtime — hoist the shared activity to the contract's global "activities" block, or rename one of them.`,
      );
    }
  }
}

/**
 * Validate a contract definition's structure. The root is strict — an
 * unknown top-level key (e.g. a misspelled `workflow`) fails instead of
 * being silently ignored, matching the strict `activityOptions` behavior.
 */
function validateContractDefinition(definition: unknown): void {
  if (!isRecord(definition)) {
    fail("contract must be an object");
  }
  assertKnownKeys("contract", definition, ["taskQueue", "workflows", "activities"]);

  const taskQueue = definition["taskQueue"];
  if (typeof taskQueue !== "string") {
    fail("taskQueue must be a string");
  }
  if (taskQueue.trim().length === 0) {
    fail("taskQueue cannot be empty");
  }

  const workflows = definition["workflows"];
  if (!isRecord(workflows)) {
    fail("workflows must be an object");
  }
  for (const [workflowName, workflow] of Object.entries(workflows)) {
    assertIdentifier("workflow", workflowName);
    validateWorkflowDefinition(`workflow "${workflowName}"`, workflow);
  }

  const activities = definition["activities"];
  if (activities !== undefined && !isRecord(activities)) {
    fail("activities must be an object");
  }
  if (activities) {
    for (const [activityName, activity] of Object.entries(activities)) {
      assertIdentifier("global activity", activityName);
      validateActivityDefinition(`global activity "${activityName}"`, activity);
    }
  }

  // Activity-only contracts (zero workflows, ≥1 global activity) are valid —
  // they model dedicated activity-pool task queues. A contract with neither
  // workflows nor activities declares nothing and is still rejected.
  if (Object.keys(workflows).length === 0 && Object.keys(activities ?? {}).length === 0) {
    fail("at least one workflow or global activity is required");
  }

  validateNameCollisions(workflows, activities);
}
