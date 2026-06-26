import { Client, Connection } from "@temporalio/client";
import { TypedClient } from "@temporal-contract/client";
import {
  orderProcessingContract,
  OrderSchema,
} from "@temporal-contract/sample-order-processing-contract";
import type { z } from "zod";
import { matchTags } from "unthrown";
import { logger } from "./logger.js";

type Order = z.infer<typeof OrderSchema>;

/**
 * Order Processing Client with unthrown AsyncResult Pattern
 *
 * This client demonstrates how to interact with the unified order processing contract
 * using unthrown's `AsyncResult` for explicit error handling.
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

  // Create type-safe client with unthrown AsyncResult pattern
  const contractClient = TypedClient.create(orderProcessingContract, rawClient);

  // Example orders to process
  const orders: Order[] = [
    {
      orderId: `ORD-${Date.now()}-001`,
      customerId: "CUST-123",
      items: [
        {
          productId: "PROD-001",
          quantity: 2,
          price: 29.99,
        },
        {
          productId: "PROD-002",
          quantity: 1,
          price: 49.99,
        },
      ],
      totalAmount: 109.97,
    },
    {
      orderId: `ORD-${Date.now()}-002`,
      customerId: "CUST-456",
      items: [
        {
          productId: "PROD-003",
          quantity: 3,
          price: 19.99,
        },
      ],
      totalAmount: 59.97,
    },
  ];

  logger.info("📦 Processing orders with unthrown AsyncResult...");

  for (const order of orders) {
    logger.info({ order }, `📦 Creating order: ${order.orderId}`);

    // Chain start → result on the AsyncResult railway: `tap` logs the started
    // handle without leaving the railway, `flatMap` sequences the dependent
    // `handle.result()` call, and its error union widens to cover both phases.
    // A single `matchTags` then folds the combined result exhaustively — every
    // modeled error tag (package-namespaced `@temporal-contract/...`) plus `Ok`
    // and `Defect` must be handled, or it is a compile error.
    const result = await contractClient
      .startWorkflow("processOrder", { workflowId: order.orderId, args: order })
      .tap((handle) => {
        logger.info({ workflowId: handle.workflowId }, `✅ Workflow started: ${handle.workflowId}`);
        logger.info("⌛ Waiting for workflow result...");
      })
      .flatMap((handle) => handle.result());

    matchTags(result, {
      Ok: (output) => {
        if (output.status === "completed") {
          logger.info(
            {
              orderId: output.orderId,
              transactionId: output.transactionId,
              trackingNumber: output.trackingNumber,
            },
            `🎉 Order ${output.orderId} completed successfully!`,
          );
        } else {
          logger.error(
            {
              orderId: output.orderId,
              failureReason: output.failureReason,
              errorCode: output.errorCode,
            },
            `❌ Order ${output.orderId} failed`,
          );
        }
      },
      "@temporal-contract/WorkflowNotFoundError": (err) =>
        logger.error({ error: err, orderId: order.orderId }, "❌ Workflow not found"),
      "@temporal-contract/WorkflowValidationError": (err) =>
        logger.error({ error: err, orderId: order.orderId }, "❌ Workflow validation failed"),
      // Idempotent fast-path: a workflow with this ID is already running (or in
      // retention). Production callers can re-fetch the existing handle; here we
      // just log and move on.
      "@temporal-contract/WorkflowAlreadyStartedError": (err) =>
        logger.warn(
          { error: err, orderId: order.orderId },
          "⏭️  Workflow already started — skipping",
        ),
      "@temporal-contract/WorkflowFailedError": (err) =>
        logger.error(
          { error: err, orderId: order.orderId, cause: err.cause },
          "❌ Workflow completed with failure",
        ),
      "@temporal-contract/WorkflowExecutionNotFoundError": (err) =>
        logger.error(
          { error: err, orderId: order.orderId },
          "❌ Workflow execution not found in namespace",
        ),
      "@temporal-contract/RuntimeClientError": (err) =>
        logger.error({ error: err, orderId: order.orderId }, "❌ Workflow execution failed"),
      // A defect is an unmodeled failure (a bug), not an anticipated outcome.
      Defect: (cause) =>
        logger.error({ cause, orderId: order.orderId }, "❌ Unexpected failure processing order"),
    });
  }

  // Example using executeWorkflow with AsyncResult pattern
  logger.info("\n📦 Example: Using executeWorkflow with AsyncResult...");

  const exampleOrder: Order = {
    orderId: `ORD-${Date.now()}-EXAMPLE`,
    customerId: "CUST-789",
    items: [
      {
        productId: "PROD-004",
        quantity: 1,
        price: 99.99,
      },
    ],
    totalAmount: 99.99,
  };

  // Execute workflow and handle result
  const result = await contractClient.executeWorkflow("processOrder", {
    workflowId: exampleOrder.orderId,
    args: exampleOrder,
  });

  // Handle the result by tag — `executeWorkflow` can surface both start-phase
  // and result-phase errors, so its union is the widest.
  matchTags(result, {
    Ok: (output) => {
      const summary = {
        id: output.orderId,
        success: output.status === "completed",
        message:
          output.status === "completed"
            ? `Order completed with tracking: ${output.trackingNumber}`
            : `Order failed: ${output.failureReason}`,
      };
      logger.info({ data: summary }, `📊 Order summary: ${summary.message}`);
    },
    "@temporal-contract/WorkflowNotFoundError": (err) =>
      logger.error({ error: err }, "❌ Workflow not found"),
    "@temporal-contract/WorkflowValidationError": (err) =>
      logger.error({ error: err }, "❌ Validation failed"),
    "@temporal-contract/WorkflowAlreadyStartedError": (err) =>
      logger.warn({ error: err }, "⏭️  Workflow already started"),
    "@temporal-contract/WorkflowFailedError": (err) =>
      logger.error({ error: err, cause: err.cause }, "❌ Workflow completed with failure"),
    "@temporal-contract/WorkflowExecutionNotFoundError": (err) =>
      logger.error({ error: err }, "❌ Workflow execution not found in namespace"),
    "@temporal-contract/RuntimeClientError": (err) =>
      logger.error({ error: err }, "❌ Workflow execution failed"),
    // A defect is an unmodeled failure (a bug), not an anticipated outcome.
    Defect: (cause) => logger.error({ cause }, "❌ Unexpected failure executing workflow"),
  });

  logger.info("\n✨ Done!");
  logger.info("");
  logger.info("💡 Benefits of unthrown AsyncResult:");
  logger.info("   - Explicit error handling - no hidden exceptions");
  logger.info("   - Type-safe error values");
  logger.info("   - Functional composition with flatMap, map, mapErr, orElse");
  logger.info("   - Railway-oriented programming");
  logger.info("   - Exhaustive error matching with unthrown matchTags");

  process.exit(0);
}

run().catch((err) => {
  logger.error({ err }, "❌ Client failed");
  process.exit(1);
});
