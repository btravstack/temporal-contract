import { z } from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  ActivityDefinition,
  AnyWorkflowDefinition,
  ContractDefinition,
  QueryDefinition,
  SearchAttributeDefinition,
  SearchAttributeKind,
  SignalDefinition,
  UpdateDefinition,
} from "./types.js";

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
 * ```
 */
export function defineSignal<TSignal extends SignalDefinition>(definition: TSignal): TSignal {
  return definition;
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
 * ```
 */
export function defineQuery<TQuery extends QueryDefinition>(definition: TQuery): TQuery {
  return definition;
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
 * ```
 */
export function defineUpdate<TUpdate extends UpdateDefinition>(definition: TUpdate): TUpdate {
  return definition;
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
 * - At least one workflow is defined
 * - Valid JavaScript identifiers are used
 * - No conflicts between global and workflow-specific activities
 * - All schemas implement the Standard Schema specification
 *
 * @template TContract - The contract definition type
 * @param definition - The complete contract definition
 * @returns The same definition with preserved types for type inference
 * @throws {Error} If the contract structure is invalid
 *
 * @example
 * ```typescript
 * import { defineContract } from '@temporal-contract/contract';
 * import { z } from 'zod';
 *
 * export const myContract = defineContract({
 *   taskQueue: 'orders',
 *   workflows: {
 *     processOrder: {
 *       input: z.object({ orderId: z.string() }),
 *       output: z.object({ success: z.boolean() }),
 *       activities: {
 *         chargePayment: {
 *           input: z.object({ amount: z.number() }),
 *           output: z.object({ transactionId: z.string() }),
 *         },
 *       },
 *     },
 *   },
 *   // Optional global activities shared across workflows
 *   activities: {
 *     logEvent: {
 *       input: z.object({ message: z.string() }),
 *       output: z.void(),
 *     },
 *   },
 * });
 * ```
 */
export function defineContract<TContract extends ContractDefinition>(
  definition: TContract,
): TContract {
  // Validate entire contract structure with Zod (including activity conflicts)
  const validationResult = contractValidationSchema.safeParse(definition);

  if (!validationResult.success) {
    const cleanMessage = getCleanErrorMessage(validationResult.error);
    throw new Error(`Contract validation failed: ${cleanMessage}`);
  }

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
 * Schema for validating JavaScript identifiers (workflow names, activity names, etc.)
 * Allows: letters, digits, underscore, dollar sign
 * Must start with: letter, underscore, or dollar sign
 */
const identifierSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, "must be a valid JavaScript identifier");

/**
 * Extract a clean, single-line error message from a Zod validation error.
 *
 * Uses `error.issues` directly (compatible with Zod v4+) rather than parsing
 * `error.message` as JSON, which was a Zod v3 implementation detail.
 */
function getCleanErrorMessage(error: z.ZodError): string {
  const issues = error.issues;
  if (!issues || issues.length === 0) {
    return error.message;
  }

  const firstIssue = issues[0];
  if (!firstIssue) {
    return error.message;
  }

  // For record key validation errors (invalid_key), surface the nested issue message
  if (
    firstIssue.code === "invalid_key" &&
    "issues" in firstIssue &&
    Array.isArray((firstIssue as { issues?: unknown[] }).issues) &&
    (firstIssue as { issues: { message?: string }[] }).issues.length > 0
  ) {
    const nestedMessage = (firstIssue as { issues: { message?: string }[] }).issues[0]?.message;
    if (nestedMessage) {
      return nestedMessage;
    }
  }

  return firstIssue.message ?? error.message;
}

/**
 * Schema for validating activity definitions
 * Checks that input and output are Standard Schema compatible schemas
 */
const activityDefinitionSchema = z.object({
  input: z.custom<StandardSchemaV1>((val) => isStandardSchema(val), {
    message: "input must be a Standard Schema compatible schema (e.g., Zod, Valibot, ArkType)",
  }),
  output: z.custom<StandardSchemaV1>((val) => isStandardSchema(val), {
    message: "output must be a Standard Schema compatible schema (e.g., Zod, Valibot, ArkType)",
  }),
});

/**
 * Schema for validating signal definitions
 */
const signalDefinitionSchema = z.object({
  input: z.custom<StandardSchemaV1>((val) => isStandardSchema(val), {
    message: "input must be a Standard Schema compatible schema (e.g., Zod, Valibot, ArkType)",
  }),
});

/**
 * Schema for validating query definitions
 */
const queryDefinitionSchema = z.object({
  input: z.custom<StandardSchemaV1>((val) => isStandardSchema(val), {
    message: "input must be a Standard Schema compatible schema (e.g., Zod, Valibot, ArkType)",
  }),
  output: z.custom<StandardSchemaV1>((val) => isStandardSchema(val), {
    message: "output must be a Standard Schema compatible schema (e.g., Zod, Valibot, ArkType)",
  }),
});

/**
 * Schema for validating update definitions
 */
const updateDefinitionSchema = z.object({
  input: z.custom<StandardSchemaV1>((val) => isStandardSchema(val), {
    message: "input must be a Standard Schema compatible schema (e.g., Zod, Valibot, ArkType)",
  }),
  output: z.custom<StandardSchemaV1>((val) => isStandardSchema(val), {
    message: "output must be a Standard Schema compatible schema (e.g., Zod, Valibot, ArkType)",
  }),
});

/**
 * Schema for validating search attribute definitions
 */
const searchAttributeKindSchema = z.enum([
  "TEXT",
  "KEYWORD",
  "INT",
  "DOUBLE",
  "BOOL",
  "DATETIME",
  "KEYWORD_LIST",
]);

const searchAttributeDefinitionSchema = z.object({
  kind: searchAttributeKindSchema,
});

/**
 * Schema for validating workflow definitions
 */
const workflowDefinitionSchema = z.object({
  input: z.custom<StandardSchemaV1>((val) => isStandardSchema(val), {
    message: "input must be a Standard Schema compatible schema (e.g., Zod, Valibot, ArkType)",
  }),
  output: z.custom<StandardSchemaV1>((val) => isStandardSchema(val), {
    message: "output must be a Standard Schema compatible schema (e.g., Zod, Valibot, ArkType)",
  }),
  activities: z.record(identifierSchema, activityDefinitionSchema).optional(),
  signals: z.record(identifierSchema, signalDefinitionSchema).optional(),
  queries: z.record(identifierSchema, queryDefinitionSchema).optional(),
  updates: z.record(identifierSchema, updateDefinitionSchema).optional(),
  searchAttributes: z.record(identifierSchema, searchAttributeDefinitionSchema).optional(),
});

/**
 * Schema for validating a contract definition structure
 */
const contractValidationSchema = z
  .object({
    taskQueue: z.string().trim().min(1, "taskQueue cannot be empty"),
    workflows: z
      .record(identifierSchema, workflowDefinitionSchema)
      .refine((workflows) => Object.keys(workflows).length > 0, {
        message: "at least one workflow is required",
      }),
    activities: z.record(identifierSchema, activityDefinitionSchema).optional(),
  })
  .superRefine((contract, ctx) => {
    // Activities are registered in a single flat namespace at runtime, so any
    // duplicate name silently clobbers another. Catch all collisions here:
    // 1. workflow-specific vs. global, and
    // 2. workflow-specific vs. other workflow-specific.
    //
    // The global owner is tracked with a Symbol rather than a sentinel string
    // because workflow names are only validated as JS identifiers — a user
    // could legitimately name a workflow "global", and a string sentinel would
    // misclassify those collisions.
    const GLOBAL_OWNER: unique symbol = Symbol("global");
    type Owner = string | typeof GLOBAL_OWNER;
    const owners = new Map<string, Owner>();

    if (contract.activities) {
      for (const activityName of Object.keys(contract.activities)) {
        owners.set(activityName, GLOBAL_OWNER);
      }
    }

    for (const [workflowName, workflow] of Object.entries(contract.workflows)) {
      if (!workflow.activities) {
        continue;
      }
      for (const activityName of Object.keys(workflow.activities)) {
        const previousOwner = owners.get(activityName);
        if (previousOwner === GLOBAL_OWNER) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `workflow "${workflowName}" has activity "${activityName}" that conflicts with a global activity. Consider renaming the workflow-specific activity or removing the global activity "${activityName}".`,
          });
          continue;
        }
        if (typeof previousOwner === "string") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `workflow "${workflowName}" has activity "${activityName}" that conflicts with the same-named activity in workflow "${previousOwner}". Activities share a single flat namespace at runtime — rename one of them.`,
          });
          continue;
        }
        owners.set(activityName, workflowName);
      }
    }
  });
