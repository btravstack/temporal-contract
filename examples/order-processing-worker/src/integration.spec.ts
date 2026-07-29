import { extname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ContractError,
  TypedClient,
  WorkflowValidationError,
  type ContractClient,
} from "@temporal-contract/client";
import {
  orderProcessingContract,
  type OrderSchema,
} from "@temporal-contract/sample-order-processing-contract";
import { it as baseIt } from "@temporal-contract/testing/extension";
import { Client } from "@temporalio/client";
import { Worker } from "@temporalio/worker";
import { describe, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";

import { activities } from "./application/activities.js";
import { paymentAdapter } from "./dependencies.js";

type Order = z.infer<typeof OrderSchema>;

const it = baseIt.extend<{
  worker: Worker;
  client: ContractClient<typeof orderProcessingContract>;
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
    const rawClient = new Client({
      connection: clientConnection,
      namespace: "default",
    });
    // Connection-scoped root (E = never, so `.get()` unwraps directly),
    // then bind the contract for the typed, contract-scoped surface.
    const typedClient = await TypedClient.create({ client: rawClient }).get();

    await use(typedClient.for(orderProcessingContract));
  },
});

describe("Order Processing Workflow - Integration Tests", () => {
  beforeEach(() => {
    // Mock payment adapter to always approve for deterministic tests
    vi.spyOn(paymentAdapter, "processPayment").mockResolvedValue({
      status: "approved",
      transactionId: "TXN-MOCK-123",
      paidAmount: 0, // Will be overridden by actual call
    });
  });

  it("should process an order successfully", async ({ client }) => {
    // GIVEN — below the $100 approval threshold, so no signal is needed
    const order: Order = {
      orderId: `ORD-TEST-${Date.now()}`,
      customerId: "CUST-TEST-001",
      items: [
        {
          productId: "PROD-001",
          quantity: 2,
          price: 19.99,
        },
        {
          productId: "PROD-002",
          quantity: 1,
          price: 49.99,
        },
      ],
      totalAmount: 89.97,
    };

    // WHEN
    const result = await client.executeWorkflow("processOrder", {
      workflowId: order.orderId,
      args: order,
    });

    // THEN
    expect(result).toBeOk();
    if (result.isOk()) {
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
    expect(handleResult).toBeOk();
    if (!handleResult.isOk()) throw new Error("Expected Ok result");
    const handle = handleResult.value;
    expect(handle.workflowId).toBe(order.orderId);

    const result = await handle.result();
    expect(result).toBeOk();
    if (result.isOk()) {
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

    // THEN — getHandle is synchronous: the only failure mode is a workflow
    // name missing from the contract, surfaced as a sync Result Err.
    const handleResult = client.getHandle("processOrder", order.orderId);

    expect(handleResult).toBeOk();
    if (!handleResult.isOk()) throw new Error("Expected Ok result");
    const handle = handleResult.value;
    expect(handle.workflowId).toBe(order.orderId);

    const result = await handle.result();
    expect(result).toBeOk();
    if (result.isOk()) {
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
          price: 49.99,
        },
      ],
      totalAmount: 49.99,
    };

    // WHEN
    const handleResult = await client.startWorkflow("processOrder", {
      workflowId: order.orderId,
      args: order,
    });

    // THEN
    expect(handleResult).toBeOk();
    if (!handleResult.isOk()) throw new Error("Expected Ok result");
    const handle = handleResult.value;

    const describeResult = await handle.describe();
    expect(describeResult).toBeOk();
    if (describeResult.isOk()) {
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
    expect(execution).toBeErr();
    if (execution.isErr()) {
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

  it("should wait for approval on high-value orders (query + signal)", async ({ client }) => {
    // GIVEN — above the $100 approval threshold
    const order: Order = {
      orderId: `ORD-TEST-${Date.now()}`,
      customerId: "CUST-TEST-007",
      items: [
        {
          productId: "PROD-008",
          quantity: 2,
          price: 74.99,
        },
      ],
      totalAmount: 149.98,
    };

    const handleResult = await client.startWorkflow("processOrder", {
      workflowId: order.orderId,
      args: order,
    });
    expect(handleResult).toBeOk();
    if (!handleResult.isOk()) throw new Error("Expected Ok result");
    const handle = handleResult.value;

    // WHEN — the argument-less query reports the approval gate
    const statusReport = await handle.queries.getOrderStatus();
    expect(statusReport).toBeOk();
    if (statusReport.isOk()) {
      expect(statusReport.value).toEqual({ status: "awaiting_approval" });
    }

    // ... and the approval signal (payload validated by the contract) lets
    // the workflow proceed
    const signalResult = await handle.signals.approveOrder({
      approvedBy: "qa@example.com",
      note: "Approved in integration test",
    });
    expect(signalResult).toBeOk();

    // THEN
    const result = await handle.result();
    expect(result).toBeOk();
    if (result.isOk()) {
      expect(result.value).toEqual({
        orderId: order.orderId,
        status: "completed",
        transactionId: expect.any(String),
        trackingNumber: expect.any(String),
      });
    }
  });

  it("should cancel a pending order via the payload-less signal", async ({ client }) => {
    // GIVEN — above the threshold, so the workflow parks at the approval gate
    const order: Order = {
      orderId: `ORD-TEST-${Date.now()}`,
      customerId: "CUST-TEST-008",
      items: [
        {
          productId: "PROD-009",
          quantity: 1,
          price: 199.99,
        },
      ],
      totalAmount: 199.99,
    };

    await client.startWorkflow("processOrder", {
      workflowId: order.orderId,
      args: order,
    });

    const handleResult = client.getHandle("processOrder", order.orderId);
    expect(handleResult).toBeOk();
    if (!handleResult.isOk()) throw new Error("Expected Ok result");
    const handle = handleResult.value;

    // WHEN — `cancelRequested` is declared with `defineSignal()` (no input
    // schema), so it is sent without arguments
    const signalResult = await handle.signals.cancelRequested();
    expect(signalResult).toBeOk();

    // THEN
    const result = await handle.result();
    expect(result).toBeOk();
    if (result.isOk()) {
      expect(result.value).toEqual({
        orderId: order.orderId,
        status: "cancelled",
        failureReason: "Cancellation requested by the customer",
        errorCode: "CANCELLED",
      });
    }
  });

  it("should surface a declined payment as the typed PaymentDeclined contract error", async ({
    client,
  }) => {
    // GIVEN - Mock payment to decline
    vi.spyOn(paymentAdapter, "processPayment").mockResolvedValue({
      status: "declined",
      reason: "insufficient_funds",
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

    // THEN — the decline travels typed end-to-end: the activity produced
    // `Err(errors.PaymentDeclined(...))`, the workflow rethrew it via
    // `context.errors.PaymentDeclined`, and the client rehydrated it into a
    // `ContractError` with the schema-validated data payload.
    expect(result).toBeErr();
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ContractError);
      const contractError = result.error as ContractError;
      expect(contractError.errorName).toBe("PaymentDeclined");
      expect(contractError.data).toEqual({ reason: "insufficient_funds" });
    }
  });
});

function workflowPath(filename: string): string {
  return fileURLToPath(new URL(`./${filename}${extname(import.meta.url)}`, import.meta.url));
}
