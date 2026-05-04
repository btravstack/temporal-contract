import { Client, Connection } from "@temporalio/client";
import {
  RuntimeClientError,
  TypedClient,
  WorkflowAlreadyStartedError,
  WorkflowExecutionNotFoundError,
  WorkflowFailedError,
  WorkflowNotFoundError,
  WorkflowValidationError,
} from "@temporal-contract/client";
import {
  orderProcessingContract,
  OrderSchema,
} from "@temporal-contract/sample-order-processing-contract";
import type { z } from "zod";
import { match, P } from "ts-pattern";
import { logger } from "./logger.js";

type Order = z.infer<typeof OrderSchema>;

/**
 * Order Processing Client with neverthrow ResultAsync Pattern
 *
 * This client demonstrates how to interact with the unified order processing contract
 * using neverthrow's `ResultAsync` for explicit error handling.
 *
 * Usage:
 *   1. Start Temporal server: temporal server start-dev
 *   2. Start a worker: cd examples/order-processing-worker && pnpm dev
 *   3. Run this client: cd examples/order-processing-client && pnpm dev
 */
async function run() {
  logger.info("🚀 Starting Order Processing Client (neverthrow ResultAsync)...");

  // Connect to Temporal server
  const connection = await Connection.connect({
    address: "localhost:7233",
  });

  const rawClient = new Client({
    connection,
    namespace: "default",
  });

  // Create type-safe client with neverthrow ResultAsync pattern
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

  logger.info("📦 Processing orders with neverthrow ResultAsync...");

  for (const order of orders) {
    logger.info({ order }, `📦 Creating order: ${order.orderId}`);

    // Start workflow and get handle
    const handleResult = await contractClient.startWorkflow("processOrder", {
      workflowId: order.orderId,
      args: order,
    });

    // Handle workflow start errors
    if (handleResult.isErr()) {
      const error = handleResult.error;
      match(error)
        .with(P.instanceOf(WorkflowNotFoundError), (err) => {
          logger.error({ error: err, orderId: order.orderId }, "❌ Workflow not found");
        })
        .with(P.instanceOf(WorkflowValidationError), (err) => {
          logger.error({ error: err, orderId: order.orderId }, "❌ Workflow validation failed");
        })
        .with(P.instanceOf(WorkflowAlreadyStartedError), (err) => {
          // Idempotent fast-path: a workflow with this ID is already running
          // (or in retention). Production callers can re-fetch the existing
          // handle and continue; here we just log and move on.
          logger.warn(
            { error: err, orderId: order.orderId },
            "⏭️  Workflow already started — skipping",
          );
        })
        .with(P.instanceOf(RuntimeClientError), (err) => {
          logger.error({ error: err, orderId: order.orderId }, "❌ Failed to start workflow");
        })
        .exhaustive();
      continue;
    }

    const handle = handleResult.value;
    logger.info({ workflowId: handle.workflowId }, `✅ Workflow started: ${handle.workflowId}`);
    logger.info("⌛ Waiting for workflow result...");

    // Get workflow result
    const result = await handle.result();

    // Handle workflow execution result
    if (result.isErr()) {
      const error = result.error;
      match(error)
        .with(P.instanceOf(WorkflowValidationError), (err) => {
          logger.error(
            { error: err, orderId: order.orderId },
            "❌ Workflow result validation failed",
          );
        })
        .with(P.instanceOf(WorkflowFailedError), (err) => {
          logger.error(
            { error: err, orderId: order.orderId, cause: err.cause },
            "❌ Workflow completed with failure",
          );
        })
        .with(P.instanceOf(WorkflowExecutionNotFoundError), (err) => {
          logger.error(
            { error: err, orderId: order.orderId },
            "❌ Workflow execution not found in namespace",
          );
        })
        .with(P.instanceOf(RuntimeClientError), (err) => {
          logger.error({ error: err, orderId: order.orderId }, "❌ Workflow execution failed");
        })
        .exhaustive();
      continue;
    }

    const output = result.value;
    // Handle successful result
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
  }

  // Example using executeWorkflow with ResultAsync pattern
  logger.info("\n📦 Example: Using executeWorkflow with ResultAsync...");

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

  // Handle result with pattern matching
  if (result.isOk()) {
    const output = result.value;
    const summary = {
      id: output.orderId,
      success: output.status === "completed",
      message:
        output.status === "completed"
          ? `Order completed with tracking: ${output.trackingNumber}`
          : `Order failed: ${output.failureReason}`,
    };
    logger.info({ data: summary }, `📊 Order summary: ${summary.message}`);
  } else {
    // Handle errors
    match(result.error)
      .with(P.instanceOf(WorkflowNotFoundError), (err) => {
        logger.error({ error: err }, "❌ Workflow not found");
      })
      .with(P.instanceOf(WorkflowValidationError), (err) => {
        logger.error({ error: err }, "❌ Validation failed");
      })
      .with(P.instanceOf(WorkflowAlreadyStartedError), (err) => {
        logger.warn({ error: err }, "⏭️  Workflow already started");
      })
      .with(P.instanceOf(WorkflowFailedError), (err) => {
        logger.error({ error: err, cause: err.cause }, "❌ Workflow completed with failure");
      })
      .with(P.instanceOf(WorkflowExecutionNotFoundError), (err) => {
        logger.error({ error: err }, "❌ Workflow execution not found in namespace");
      })
      .with(P.instanceOf(RuntimeClientError), (err) => {
        logger.error({ error: err }, "❌ Workflow execution failed");
      })
      .exhaustive();
  }

  logger.info("\n✨ Done!");
  logger.info("");
  logger.info("💡 Benefits of neverthrow ResultAsync:");
  logger.info("   - Explicit error handling - no hidden exceptions");
  logger.info("   - Type-safe error values");
  logger.info("   - Functional composition with andThen, map, mapErr, orElse");
  logger.info("   - Railway-oriented programming");
  logger.info("   - Exhaustive error matching with ts-pattern");

  process.exit(0);
}

run().catch((err) => {
  logger.error({ err }, "❌ Client failed");
  process.exit(1);
});
