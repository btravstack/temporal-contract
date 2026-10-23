import { defineContract } from "./builder.js";
import type { ContractDefinition } from "./types.js";

/**
 * Bind a compatible protocol to a deployment task queue without changing its
 * workflow names, schemas, activity destinations or workflow execution IDs.
 * Resolve before starting work, or from a recorded decision during replay.
 */
export function defineContractBinding<C extends ContractDefinition, const Queue extends string>(
  contract: C,
  options: { taskQueue: Queue },
): Omit<C, "taskQueue"> & { taskQueue: Queue } {
  return defineContract({ ...contract, taskQueue: options.taskQueue });
}
