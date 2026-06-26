import { describe, expect, vi, beforeEach } from "vitest";
import { isOk, isErr } from "unthrown";
import { Worker } from "@temporalio/worker";
import { TypedClient, WorkflowValidationError } from "@temporal-contract/client";
import { it as baseIt } from "@temporal-contract/testing/extension";
import {
  orderProcessingContract,
  OrderSchema,
} from "@temporal-contract/sample-order-processing-contract";
import { activities } from "./application/activities.js";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { paymentAdapter } from "./dependencies.js";
import { Client } from "@temporalio/client";

type Order = z.infer<typeof OrderSchema>;

const it = baseIt.extend<{
  worker: Worker;
  client: TypedClient<typeof orderProcessingContract>;
}>({
  worker: [
    async ({ workerConnection }, use) => {
      // Create and start worker
      const worker = await Worker.create({
        connection: workerConnection,
        namespace: "default",
        taskQueue: orderProcessingContract.taskQueue,
        workflowsPath: workflowPath("application/workflows"),
        activities,
      });

      // Start worker in background
      worker.run().catch((err) => {
        console.error("Worker failed:", err);
      });

      await vi.waitFor(() => worker.getState() === "RUNNING", { interval: 100 });

      await use(worker);

      worker.shutdown();

      await vi.waitFor(() => worker.getState() === "STOPPED", { interval: 100 });
    },
    { auto: true },
  ],
  client: async ({ clientConnection }, use) => {
    // Create typed client
    const rawClient = new Client({
      connection: clientConnection,
      namespace: "default",
    });
    const client = TypedClient.create(orderProcessingContract, rawClient);

    await use(client);
  },
});

describe("Order Processing Workflow - Integration Tests", () => {
  beforeEach(() => {
    // Mock payment adapter to always succeed for deterministic tests
    vi.spyOn(paymentAdapter, "processPayment").mockResolvedValue({
      transactionId: "TXN-MOCK-123",
      status: "success",
      paidAmount: 0, // Will be overridden by actual call
    });
  });

  it("should process an order successfully", async ({ client }) => {
    // GIVEN
    const order: Order = {
      orderId: `ORD-TEST-${Date.now()}`,
      customerId: "CUST-TEST-001",
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
    };

    // WHEN
    const result = await client.executeWorkflow("processOrder", {
      workflowId: order.orderId,
      args: order,
    });

    // THEN
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({
        orderId: order.orderId,
        status: "completed",
        transactionId: expect.any(String),
        trackingNumber: expect.any(String),
      });
    }
  });

  it("should handle workflow with startWorkflow and result", async ({ client }) => {
    // GIVEN
    const order: Order = {
      orderId: `ORD-TEST-${Date.now()}`,
      customerId: "CUST-TEST-002",
      items: [
        {
          productId: "PROD-003",
          quantity: 1,
          price: 99.99,
        },
      ],
      totalAmount: 99.99,
    };

    // WHEN
    const handleResult = await client.startWorkflow("processOrder", {
      workflowId: order.orderId,
      args: order,
    });

    // THEN
    expect(isOk(handleResult)).toBe(true);
    if (!isOk(handleResult)) throw new Error("Expected Ok result");
    const handle = handleResult.value;
    expect(handle.workflowId).toBe(order.orderId);

    const result = await handle.result();
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({
        orderId: order.orderId,
        status: "completed",
        transactionId: expect.any(String),
        trackingNumber: expect.any(String),
      });
    }
  });

  it("should be able to get workflow handle after start", async ({ client }) => {
    // GIVEN
    const order: Order = {
      orderId: `ORD-TEST-${Date.now()}`,
      customerId: "CUST-TEST-003",
      items: [
        {
          productId: "PROD-004",
          quantity: 3,
          price: 19.99,
        },
      ],
      totalAmount: 59.97,
    };

    // WHEN
    await client.startWorkflow("processOrder", {
      workflowId: order.orderId,
      args: order,
    });

    // THEN
    const handleResult = await client.getHandle("processOrder", order.orderId);

    expect(isOk(handleResult)).toBe(true);
    if (!isOk(handleResult)) throw new Error("Expected Ok result");
    const handle = handleResult.value;
    expect(handle.workflowId).toBe(order.orderId);

    const result = await handle.result();
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({
        orderId: order.orderId,
        status: "completed",
        transactionId: expect.any(String),
        trackingNumber: expect.any(String),
      });
    }
  });

  it("should handle describe and terminate operations", async ({ client }) => {
    // GIVEN
    const order: Order = {
      orderId: `ORD-TEST-${Date.now()}`,
      customerId: "CUST-TEST-004",
      items: [
        {
          productId: "PROD-005",
          quantity: 1,
          price: 149.99,
        },
      ],
      totalAmount: 149.99,
    };

    // WHEN
    const handleResult = await client.startWorkflow("processOrder", {
      workflowId: order.orderId,
      args: order,
    });

    // THEN
    expect(isOk(handleResult)).toBe(true);
    if (!isOk(handleResult)) throw new Error("Expected Ok result");
    const handle = handleResult.value;

    const describeResult = await handle.describe();
    expect(isOk(describeResult)).toBe(true);
    if (isOk(describeResult)) {
      expect(describeResult.value).toEqual(
        expect.objectContaining({ workflowId: order.orderId, type: "processOrder" }),
      );
    }

    await handle.result();
  });

  it("should validate input data with Zod", async ({ client }) => {
    // GIVEN
    const invalidOrder = {
      orderId: `ORD-TEST-${Date.now()}`,
      customerId: "CUST-TEST-005",
      items: [
        {
          productId: "PROD-006",
          quantity: -1, // Invalid: negative quantity
          price: 29.99,
        },
      ],
      totalAmount: 29.99,
    };

    // WHEN
    const execution = await client.executeWorkflow("processOrder", {
      workflowId: invalidOrder.orderId,
      args: invalidOrder as Order,
    });

    // THEN
    expect(isErr(execution)).toBe(true);
    if (isErr(execution)) {
      expect(execution.error).toBeInstanceOf(WorkflowValidationError);
      const validationError = execution.error as WorkflowValidationError;
      expect(validationError.workflowName).toBe("processOrder");
      expect(validationError.direction).toBe("input");
      expect(validationError.issues).toEqual([
        {
          origin: "number",
          code: "too_small",
          minimum: 0,
          inclusive: false,
          path: ["items", 0, "quantity"],
          message: "Too small: expected number to be >0",
        },
      ]);
    }
  });

  it("should handle payment failure", async ({ client }) => {
    // GIVEN - Mock payment to fail
    vi.spyOn(paymentAdapter, "processPayment").mockResolvedValue({
      status: "failed",
    });

    const order: Order = {
      orderId: `ORD-TEST-${Date.now()}`,
      customerId: "CUST-TEST-006",
      items: [
        {
          productId: "PROD-007",
          quantity: 1,
          price: 99.99,
        },
      ],
      totalAmount: 99.99,
    };

    // WHEN
    const result = await client.executeWorkflow("processOrder", {
      workflowId: order.orderId,
      args: order,
    });

    // THEN - Should return failed status
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({
        status: "failed",
        errorCode: "PAYMENT_FAILED",
        failureReason: "Payment was declined",
        orderId: order.orderId,
      });
    }
  });
});

function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}
