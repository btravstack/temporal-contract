import { extname } from "node:path";

import { orderProcessingContract } from "@temporal-contract/sample-order-processing-contract";
import { TypedWorker, workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { NativeConnection } from "@temporalio/worker";

import { logger } from "../logger.js";
import { activities } from "./activities.js";

/**
 * Start the Temporal Worker
 *
 * The worker:
 * - Loads workflows from the workflows directory using workflowsPath
 * - Registers activities from the activities handler
 * - Listens on the 'order-processing' task queue (from contract)
 */
async function run() {
  logger.info("🚀 Starting Order Processing Worker...");

  // Create connection to Temporal server
  const connection = await NativeConnection.connect({
    address: "localhost:7233",
  });

  // Creation failures ride the defect channel, not the Err channel and not a
  // throw — see "Setup calls have an empty Err channel" in
  // docs/explanation/the-result-model.md.
  const workerResult = await TypedWorker.create({
    contract: orderProcessingContract,
    connection,
    namespace: "default",
    // This sample runs straight from TypeScript source under `tsx`, so the
    // sibling module is `workflows.ts` here and `workflows.js` once built —
    // hence `extname(import.meta.url)` rather than a literal `.js`. An app
    // that only ever runs built output writes `"./workflows.js"`.
    workflowsPath: workflowsPathFromURL(import.meta.url, `./workflows${extname(import.meta.url)}`),
    activities,
  });
  if (workerResult.isDefect()) {
    logger.error({ err: workerResult.cause }, "❌ Worker creation failed");
    process.exit(1);
  }
  const worker = workerResult.get();

  logger.info("✅ Worker registered successfully");

  // `run()` is `AsyncResult<void, never>` for the same reason: a runtime
  // failure is a defect, and `.get()` rethrows its cause.
  await worker.run().get();
}

run().catch((err) => {
  logger.error({ err }, "❌ Worker failed");
  process.exit(1);
});
