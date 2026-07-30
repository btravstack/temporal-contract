import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

/**
 * Activity-less contract used by the workflow-registration-check unit specs
 * (`../worker.spec.ts`). Two workflows so the specs can cover "one missing"
 * and "one mismatched" independently.
 */

const alpha = defineWorkflow({
  input: z.object({ value: z.string() }),
  output: z.object({ result: z.string() }),
});

const beta = defineWorkflow({
  input: z.object({ n: z.number() }),
  output: z.object({ doubled: z.number() }),
});

export const registrationContract = defineContract({
  taskQueue: "registration-check-queue",
  workflows: { alpha, beta },
});
