import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

// Composition-first: one workflow per idempotency mode, all sharing the same
// `{ shouldFail }` -> `{ ok }` shape. A single fixture module (see
// idempotency.workflows.ts) can then produce either a Completed or a Failed
// run per mode, which is exactly the pair the dedup specs need to start a
// second time against.

const input = z.object({ shouldFail: z.boolean() });
const output = z.object({ ok: z.boolean() });

const onceWorkflow = defineWorkflow({
  input,
  output,
  startPolicy: "once-per-id",
});

const retryWorkflow = defineWorkflow({
  input,
  output,
  startPolicy: "retry-if-failed",
});

const allowWorkflow = defineWorkflow({
  input,
  output,
  startPolicy: "allow-duplicate",
});

export const idempotencyContract = defineContract({
  taskQueue: "idempotency-tests",
  workflows: { onceWorkflow, retryWorkflow, allowWorkflow },
});
