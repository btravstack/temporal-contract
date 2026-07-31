import {
  SCHEDULE_NOT_FOUND_ERROR_TAG,
  SCHEDULE_ALREADY_EXISTS_ERROR_TAG,
  SIGNAL_VALIDATION_ERROR_TAG,
  tagPatterns,
  TypedClient,
  WORKFLOW_ALREADY_STARTED_ERROR_TAG,
  WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG,
  WORKFLOW_FAILED_ERROR_TAG,
  WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG,
  WORKFLOW_OUTCOME_ERROR_TAGS,
  WORKFLOW_RESULT_ERROR_TAGS,
  WORKFLOW_START_ERROR_TAGS,
  WORKFLOW_VALIDATION_ERROR_TAG,
} from "@temporal-contract/client";
import {
  orderProcessingContract,
  type OrderSchema,
} from "@temporal-contract/sample-order-processing-contract";
import { Client, Connection } from "@temporalio/client";
import { P } from "unthrown";
import type { z } from "zod";

import { logger } from "./logger.js";

type Order = z.infer<typeof OrderSchema>;

/**
 * Order Processing Client with unthrown AsyncResult Pattern
 *
 * Demonstrates the full typed-client surface against the shared contract:
 * - `TypedClient.create({ client })` (connection-scoped root) +
 *   `.for(contract)` (contract-scoped client)
 * - start / query / signal / result through a typed workflow handle
 * - a payload-less signal (`cancelRequested`) sent through a handle obtained
 *   with the synchronous `getHandle`
 * - `executeWorkflow` with exhaustive error matching, including the typed
 *   `PaymentDeclined` contract error
 * - a recurring schedule (`schedule.create`) with the create-if-absent idiom
 *
 * Usage:
 *   1. Start Temporal server: temporal server start-dev
 *   2. Start a worker: cd examples/order-processing-worker && pnpm dev
 *   3. Run this client: cd examples/order-processing-client && pnpm dev
 */
async function run() {
  logger.info("🚀 Starting Order Processing Client (unthrown AsyncResult)...");

  // Connect to Temporal server
  const connection = await Connection.connect({
    address: "localhost:7233",
  });

  const rawClient = new Client({
    connection,
    namespace: "default",
  });

  // Connection-scoped root — create once at process start. Creation failures
  // (bad connection, missing Schedule API) are technical faults that ride the
  // defect channel (a `TechnicalError` cause), so the Err channel is empty
  // (`never`) and `.get()` unwraps directly (a setup defect rethrows its
  // cause).
  const typedClient = await TypedClient.create({ client: rawClient }).get();

  // Contract-scoped client — binding a contract is synchronous, infallible,
  // and memoized, so `for(contract)` is free to call anywhere.
  const orders = typedClient.for(orderProcessingContract);

  // ==========================================================================
  // 1. High-value order: start → query → approve signal → result
  // ==========================================================================
  logger.info("📦 Example 1: high-value order with approval signal + status query...");

  const approvalOrder: Order = {
    orderId: `ORD-${Date.now()}-APPROVAL`,
    customerId: "CUST-123",
    items: [
      { productId: "PROD-001", quantity: 2, price: 49.99 },
      { productId: "PROD-002", quantity: 1, price: 49.99 },
    ],
    totalAmount: 149.97, // above the worker's $100 approval threshold
  };

  const startResult = await orders.startWorkflow("processOrder", {
    workflowId: approvalOrder.orderId,
    args: approvalOrder,
  });
  if (!startResult.isOk()) {
    logger.error(
      { err: startResult.isErr() ? startResult.error : startResult.cause },
      "❌ Failed to start workflow",
    );
    process.exit(1);
  }
  const handle = startResult.value;
  logger.info({ workflowId: handle.workflowId }, `✅ Workflow started: ${handle.workflowId}`);

  // Argument-less query through the typed handle — the contract declares
  // `getOrderStatus` with `defineQuery({ output })`, so no input is passed.
  const statusBefore = await handle.queries.getOrderStatus();
  if (statusBefore.isOk()) {
    logger.info({ report: statusBefore.value }, `🔎 Status: ${statusBefore.value.status}`);
  }

  // Payload-carrying signal, validated against the contract's input schema.
  const approvalSent = await handle.signals.approveOrder({
    approvedBy: "ops@example.com",
    note: "Verified with finance",
  });
  approvalSent.match({
    ok: () => logger.info("✍️  Approval signal sent"),
    errCases: (matcher) =>
      matcher
        .with(P.tag(SIGNAL_VALIDATION_ERROR_TAG), (err) =>
          logger.error({ error: err }, "❌ Signal payload rejected by the contract"),
        )
        .with(P.tag(WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG), (err) =>
          logger.error({ error: err }, "❌ Workflow execution not found"),
        ),
    defect: (cause) => logger.error({ cause }, "❌ Unexpected failure sending signal"),
  });

  logger.info("⌛ Waiting for workflow result...");
  const approvalOutcome = await handle.result();
  approvalOutcome.match({
    ok: (output) =>
      logger.info(
        { orderId: output.orderId, trackingNumber: output.trackingNumber },
        `🎉 Order ${output.orderId} finished with status "${output.status}"`,
      ),
    errCases: (matcher) =>
      matcher
        // Typed domain error declared in the workflow's `errors:` block. The
        // object pattern narrows the shared-`_tag` `ContractError` union by
        // `errorName`, so `err.data` is typed `{ reason: string }`.
        .with({ errorName: "PaymentDeclined" }, (err) =>
          logger.error(
            { errorName: err.errorName, reason: err.data.reason },
            `❌ Payment declined: ${err.data.reason}`,
          ),
        )
        // Everything else the result phase can surface — validation, generic
        // failure, the first-class outcome trio (cancelled/terminated/timed
        // out), and a missing execution — grouped via the exported bundle.
        .with(...tagPatterns(WORKFLOW_RESULT_ERROR_TAGS), (err) =>
          logger.error({ error: err }, "❌ Workflow did not complete successfully"),
        ),
    defect: (cause) => logger.error({ cause }, "❌ Unexpected failure awaiting result"),
  });

  // ==========================================================================
  // 2. Cancellation: payload-less signal via a handle from `getHandle`
  // ==========================================================================
  logger.info("📦 Example 2: cancelling a pending order with a payload-less signal...");

  const cancelOrder: Order = {
    orderId: `ORD-${Date.now()}-CANCEL`,
    customerId: "CUST-456",
    items: [{ productId: "PROD-003", quantity: 3, price: 39.99 }],
    totalAmount: 119.97, // above the threshold — waits for approval, giving us time to cancel
  };

  const cancelStart = await orders.startWorkflow("processOrder", {
    workflowId: cancelOrder.orderId,
    args: cancelOrder,
  });
  if (!cancelStart.isOk()) {
    logger.error(
      { err: cancelStart.isErr() ? cancelStart.error : cancelStart.cause },
      "❌ Failed to start workflow",
    );
    process.exit(1);
  }

  // `getHandle` is synchronous: the only failure mode is a workflow name
  // missing from the contract, surfaced as a sync `Result` Err. Whether the
  // *execution* exists is answered lazily by the handle's methods.
  const fetchedHandle = orders.getHandle("processOrder", cancelOrder.orderId);
  if (!fetchedHandle.isOk()) {
    logger.error(
      { err: fetchedHandle.isErr() ? fetchedHandle.error : fetchedHandle.cause },
      "❌ Workflow not in contract",
    );
    process.exit(1);
  }
  const cancelHandle = fetchedHandle.value;

  // Payload-less signal — `defineSignal()` in the contract, sent with no
  // arguments.
  await cancelHandle.signals.cancelRequested();
  logger.info("🛑 Cancellation signal sent");

  const cancelOutcome = await cancelHandle.result();
  cancelOutcome.match({
    ok: (output) =>
      logger.info(
        { orderId: output.orderId, errorCode: output.errorCode },
        `✅ Order ${output.orderId} finished with status "${output.status}"`,
      ),
    errCases: (matcher) =>
      matcher
        .with({ errorName: "PaymentDeclined" }, (err) =>
          logger.error({ errorName: err.errorName }, "❌ Payment declined"),
        )
        // The first-class outcome errors get their own arm here: a
        // server-side cancel / terminate / timeout is a distinct outcome,
        // not a generic "failure" — no `err.cause instanceof ...` digging.
        .with(...tagPatterns(WORKFLOW_OUTCOME_ERROR_TAGS), (err) =>
          logger.warn({ error: err }, `🛑 Workflow ${err.name}: execution was stopped`),
        )
        .with(P.tag(WORKFLOW_VALIDATION_ERROR_TAG), (err) =>
          logger.error({ error: err }, "❌ Workflow output validation failed"),
        )
        .with(P.tag(WORKFLOW_FAILED_ERROR_TAG), (err) =>
          logger.error({ error: err, cause: err.cause }, "❌ Workflow completed with failure"),
        )
        .with(P.tag(WORKFLOW_EXECUTION_NOT_FOUND_ERROR_TAG), (err) =>
          logger.error({ error: err }, "❌ Workflow execution not found in namespace"),
        ),
    defect: (cause) => logger.error({ cause }, "❌ Unexpected failure awaiting result"),
  });

  // ==========================================================================
  // 3. executeWorkflow: small order, exhaustive error matching
  // ==========================================================================
  logger.info("📦 Example 3: executeWorkflow with exhaustive error matching...");

  const quickOrder: Order = {
    orderId: `ORD-${Date.now()}-QUICK`,
    customerId: "CUST-789",
    items: [{ productId: "PROD-004", quantity: 1, price: 59.97 }],
    totalAmount: 59.97, // below the threshold — no approval needed
  };

  // `executeWorkflow` combines start + result, so its error union is the
  // widest: every modeled tag (package-namespaced `@temporal-contract/...`)
  // plus `Ok` and `Defect` must be handled, or it is a compile error.
  const executeResult = await orders.executeWorkflow("processOrder", {
    workflowId: quickOrder.orderId,
    args: quickOrder,
  });

  executeResult.match({
    ok: (output) => {
      const summary = {
        id: output.orderId,
        success: output.status === "completed",
        message:
          output.status === "completed"
            ? `Order completed with tracking: ${output.trackingNumber}`
            : `Order ${output.status}: ${output.failureReason}`,
      };
      logger.info({ data: summary }, `📊 Order summary: ${summary.message}`);
    },
    errCases: (matcher) =>
      matcher
        // The typed PaymentDeclined contract error, rehydrated from the
        // workflow's ApplicationFailure wire shape and narrowed by the
        // `errorName` object pattern.
        .with({ errorName: "PaymentDeclined" }, (err) =>
          logger.error(
            { errorName: err.errorName, reason: err.data.reason },
            `❌ Payment declined: ${err.data.reason}`,
          ),
        )
        // Idempotent fast-path: a workflow with this ID is already running
        // (or in retention). Production callers can re-fetch the existing
        // handle; here we just log and move on. (Handled before the grouped
        // bundles so it keeps its dedicated branch.)
        .with(P.tag(WORKFLOW_ALREADY_STARTED_ERROR_TAG), (err) =>
          logger.warn({ error: err }, "⏭️  Workflow already started — skipping"),
        )
        // Everything else executeWorkflow can err with — the start-phase and
        // result-phase bundles together cover the full union, so a widened
        // union in a future release fails compilation right here.
        .with(
          ...tagPatterns(WORKFLOW_START_ERROR_TAGS),
          ...tagPatterns(WORKFLOW_RESULT_ERROR_TAGS),
          (err) => logger.error({ error: err }, "❌ Order processing failed"),
        ),
    // A defect is an unmodeled failure (a bug) — including technical/
    // infrastructure faults like a dropped connection (a `RuntimeClientError`
    // cause) — not an anticipated outcome.
    defect: (cause) => logger.error({ cause }, "❌ Unexpected failure executing workflow"),
  });

  // ==========================================================================
  // 4. Schedule: recurring order cleanup (create-if-absent idiom)
  // ==========================================================================
  logger.info("📦 Example 4: recurring cleanup schedule (create-if-absent)...");

  const scheduleId = "order-cleanup-nightly";
  const createScheduleResult = await orders.schedule.create("cleanupExpiredOrders", {
    scheduleId,
    spec: { cronExpressions: ["0 3 * * *"] }, // every night at 03:00
    args: { olderThanDays: 30 },
  });

  const scheduleHandle = createScheduleResult.match({
    ok: (created) => {
      logger.info({ scheduleId: created.scheduleId }, "🗓️  Cleanup schedule created");
      return created;
    },
    errCases: (matcher) =>
      matcher
        // Create-if-absent: a colliding running schedule is a modeled error,
        // so idempotent callers just reuse the existing one.
        .with(P.tag(SCHEDULE_ALREADY_EXISTS_ERROR_TAG), (err) => {
          logger.info({ scheduleId: err.scheduleId }, "⏭️  Schedule already exists — reusing it");
          return orders.schedule.getHandle(err.scheduleId);
        })
        .with(P.tag(WORKFLOW_NOT_IN_CONTRACT_ERROR_TAG), (err) => {
          logger.error({ error: err }, "❌ Workflow not declared in the contract");
          return undefined;
        })
        .with(P.tag(WORKFLOW_VALIDATION_ERROR_TAG), (err) => {
          logger.error({ error: err }, "❌ Schedule args rejected by the contract");
          return undefined;
        }),
    defect: (cause) => {
      logger.error({ cause }, "❌ Unexpected failure creating schedule");
      return undefined;
    },
  });

  if (scheduleHandle) {
    // Fire the cleanup once right now instead of waiting for 03:00.
    const triggerResult = await scheduleHandle.trigger();
    triggerResult.match({
      ok: () => logger.info("🧹 Cleanup run triggered immediately"),
      errCases: (matcher) =>
        matcher.with(P.tag(SCHEDULE_NOT_FOUND_ERROR_TAG), (err) =>
          logger.error({ error: err }, "❌ Schedule vanished before it could be triggered"),
        ),
      defect: (cause) => logger.error({ cause }, "❌ Unexpected failure triggering schedule"),
    });
  }

  logger.info("✨ Done!");
  logger.info("");
  logger.info("💡 What this client demonstrated:");
  logger.info("   - TypedClient.create({ client }) + .for(contract) split");
  logger.info("   - Typed signals (with and without payload) and queries");
  logger.info("   - A typed contract error matched with the { errorName } object pattern");
  logger.info("   - schedule.create with the ScheduleAlreadyExistsError branch");
  logger.info("   - Exhaustive error matching — every tag or it doesn't compile");

  process.exit(0);
}

run().catch((err) => {
  logger.error({ err }, "❌ Client failed");
  process.exit(1);
});
