import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Base types for validation schemas
 * Any schema that implements the Standard Schema specification
 * This includes Zod, Valibot, ArkType, and other compatible libraries
 */
export type AnySchema = StandardSchemaV1;

/**
 * Definition of an activity
 */
export type ActivityDefinition<
  TInput extends AnySchema = AnySchema,
  TOutput extends AnySchema = AnySchema,
> = {
  readonly input: TInput;
  readonly output: TOutput;
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
 * Definition of a workflow
 */
export type WorkflowDefinition<
  TActivities extends Record<string, ActivityDefinition> = Record<string, ActivityDefinition>,
  TSignals extends Record<string, SignalDefinition> = Record<string, SignalDefinition>,
  TQueries extends Record<string, QueryDefinition> = Record<string, QueryDefinition>,
  TUpdates extends Record<string, UpdateDefinition> = Record<string, UpdateDefinition>,
  TSearchAttributes extends Record<string, SearchAttributeDefinition> = Record<
    string,
    SearchAttributeDefinition
  >,
> = {
  readonly input: AnySchema;
  readonly output: AnySchema;
  readonly activities?: TActivities;
  readonly signals?: TSignals;
  readonly queries?: TQueries;
  readonly updates?: TUpdates;
  readonly searchAttributes?: TSearchAttributes;
};

/**
 * Contract definition containing workflows and optional global activities
 */
export type ContractDefinition<
  TWorkflows extends Record<string, WorkflowDefinition> = Record<string, WorkflowDefinition>,
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
