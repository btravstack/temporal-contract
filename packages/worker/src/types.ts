// The direction-aware schema inference primitives live in
// `@temporal-contract/contract` (single source of truth shared with the
// client package); this module re-exports them so in-package imports and the
// worker's public type surface are unchanged.
import type {
  AnyWorkflowDefinition,
  QueryDefinition,
  SignalDefinition,
  UpdateDefinition,
} from "@temporal-contract/contract";

export type {
  ClientInferInput,
  ClientInferOutput,
  WorkerInferInput,
  WorkerInferOutput,
} from "@temporal-contract/contract";

/**
 * Resolve the {@link SignalDefinition} declared under name `K` on a workflow,
 * or `never` when the workflow declares no signals / no such signal.
 *
 * The double conditional (map shape first, then the indexed entry) tolerates
 * the optional `signals` slot under `exactOptionalPropertyTypes` and keeps
 * unknown names collapsing to `never` so handler payloads stay sound.
 * Shared by `WorkflowContext.handleSignal` and the typed child-workflow
 * handle's `signals` map.
 */
export type SignalDefOf<TWorkflow extends AnyWorkflowDefinition, K extends PropertyKey> =
  NonNullable<TWorkflow["signals"]> extends Record<string, SignalDefinition>
    ? NonNullable<TWorkflow["signals"]>[K &
        keyof NonNullable<TWorkflow["signals"]>] extends SignalDefinition
      ? NonNullable<TWorkflow["signals"]>[K & keyof NonNullable<TWorkflow["signals"]>]
      : never
    : never;

/**
 * Resolve the {@link QueryDefinition} declared under name `K` on a workflow,
 * or `never` when the workflow declares no queries / no such query.
 * See {@link SignalDefOf} for the shape rationale.
 */
export type QueryDefOf<TWorkflow extends AnyWorkflowDefinition, K extends PropertyKey> =
  NonNullable<TWorkflow["queries"]> extends Record<string, QueryDefinition>
    ? NonNullable<TWorkflow["queries"]>[K &
        keyof NonNullable<TWorkflow["queries"]>] extends QueryDefinition
      ? NonNullable<TWorkflow["queries"]>[K & keyof NonNullable<TWorkflow["queries"]>]
      : never
    : never;

/**
 * Resolve the {@link UpdateDefinition} declared under name `K` on a workflow,
 * or `never` when the workflow declares no updates / no such update.
 * See {@link SignalDefOf} for the shape rationale.
 */
export type UpdateDefOf<TWorkflow extends AnyWorkflowDefinition, K extends PropertyKey> =
  NonNullable<TWorkflow["updates"]> extends Record<string, UpdateDefinition>
    ? NonNullable<TWorkflow["updates"]>[K &
        keyof NonNullable<TWorkflow["updates"]>] extends UpdateDefinition
      ? NonNullable<TWorkflow["updates"]>[K & keyof NonNullable<TWorkflow["updates"]>]
      : never
    : never;
