import { defineContract } from "./builder.js";
import type { ContractDefinition } from "./types.js";

/**
 * Bind a compatible protocol to a deployment task queue without changing its
 * workflow names, schemas, activity destinations or workflow execution IDs.
 * Resolve before starting work, or from a recorded decision during replay.
 *
 * @template C - The source protocol contract
 * @template Queue - The physical deployment task queue
 * @param contract - The protocol whose definitions remain shared
 * @param options - The deployment destination
 * @param options.taskQueue - A non-empty, trimmed queue name within Temporal's limit
 * @returns A new validated contract preserving definitions and the queue's literal type
 * @throws {ContractDefinitionError} If the bound contract or task queue is invalid
 */
export function defineContractBinding<C extends ContractDefinition, const Queue extends string>(
  contract: C,
  options: { taskQueue: Queue },
): Omit<C, "taskQueue"> & { taskQueue: Queue } {
  return defineContract({ ...contract, taskQueue: options.taskQueue });
}
