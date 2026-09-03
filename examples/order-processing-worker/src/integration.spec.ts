import { ContractError, WorkflowValidationError } from "@temporal-contract/client";
import {
  orderProcessingContract,
  type OrderSchema,
} from "@temporal-contract/sample-order-processing-contract";
import { createContractTest } from "@temporal-contract/testing/contract";
import { fixturePath } from "@temporal-contract/testing/workflow-bundle";
import { describe, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";

import { activities } from "./application/activities.js";
import { paymentAdapter } from "./dependencies.js";

type Order = z.infer<typeof OrderSchema>;

const it = createContractTest({
  contract: orderProcessingContract,
  // `fixturePath` derives the extension from the CALLER's URL, so this
  // resolves to `.ts` under vitest and `.js` from built output.
  // `workflowsPathFromURL` takes the extension literally and is the right
  // helper once the workflows really are `.js` on disk.
  workflowsPath: fixturePath(import.meta.url, "application/workflows"),
  activities,
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
      args: order,
    });

    // THEN
    expect(handleResult).toBeOk();
    if (!handleResult.isOk()) throw new Error("Expected Ok result");
    const handle = handleResult.value;
    // The contract derived it: `order-${orderId}`.
    expect(handle.workflowId).toBe(`order-${order.orderId}`);

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
    const started = await client.startWorkflow("processOrder", { args: order });
    expect(started).toBeOk();
    if (!started.isOk()) throw new Error("Expected Ok result");

    // THEN — getHandle is synchronous: the only failure mode is a workflow
    // name missing from the contract, surfaced as a sync Result Err. It
    // addresses an execution by ID, so for a workflow whose ID the contract
    // derives, read that ID off the start result rather than re-deriving it.
    const handleResult = client.getHandle("processOrder", started.value.workflowId);

    expect(handleResult).toBeOk();
    if (!handleResult.isOk()) throw new Error("Expected Ok result");
    const handle = handleResult.value;
    // The contract derived it: `order-${orderId}`.
    expect(handle.workflowId).toBe(`order-${order.orderId}`);

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
        expect.objectContaining({ workflowId: `order-${order.orderId}`, type: "processOrder" }),
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

    const started = await client.startWorkflow("processOrder", { args: order });
    expect(started).toBeOk();
    if (!started.isOk()) throw new Error("Expected Ok result");

    // The ID came from the contract's derivation — take it from the start
    // result instead of re-deriving it at the call site.
    const handleResult = client.getHandle("processOrder", started.value.workflowId);
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
