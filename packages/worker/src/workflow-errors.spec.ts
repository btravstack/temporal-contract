/**
 * Runtime coverage for workflow-level contract errors: a
 * `throw context.errors.X(...)` from the implementation must leave the
 * workflow function as an `ApplicationFailure` (`type` = error name,
 * `details[0]` = validated data) — a plain thrown `Error` would be retried
 * as a Workflow Task failure forever.
 *
 * Mocks `@temporalio/workflow` so the declared workflow function is callable
 * outside a real workflow sandbox.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract } from "@temporal-contract/contract";
import { ApplicationFailure } from "@temporalio/common";

vi.mock("@temporalio/workflow", async () => {
  const actual =
    await vi.importActual<typeof import("@temporalio/workflow")>("@temporalio/workflow");
  return {
    ...actual,
    proxyActivities: () =>
      new Proxy(
        {},
        {
          get: () => () => Promise.resolve({}),
        },
      ),
    workflowInfo: () => ({ workflowId: "test-wf", runId: "test-run" }),
  };
});

// Import *after* the mock so the module under test sees our stub.
const { declareWorkflow, ContractErrorDataValidationError } = await import("./workflow.js");

const contract = defineContract({
  taskQueue: "tq",
  workflows: {
    processOrder: {
      input: z.object({ orderId: z.string() }),
      output: z.object({ status: z.string() }),
      errors: {
        EmptyOrder: {
          data: z.object({ orderId: z.string() }),
          message: "Order has no items",
          nonRetryable: true,
        },
      },
    },
  },
});

describe("declareWorkflow — contract errors", () => {
  it("converts a thrown context error into an ApplicationFailure", async () => {
    const fn = declareWorkflow({
      workflowName: "processOrder",
      contract,
      activityOptions: { startToCloseTimeout: "1 minute" },
      implementation: async (context, args) => {
        throw context.errors.EmptyOrder({ orderId: args.orderId });
      },
    });

    const rejection = fn({ orderId: "ORD-1" });
    await expect(rejection).rejects.toBeInstanceOf(ApplicationFailure);
    await expect(rejection).rejects.toMatchObject({
      type: "EmptyOrder",
      message: "Order has no items",
      nonRetryable: true,
      details: [{ orderId: "ORD-1" }],
    });
  });

  it("fails fast when the thrown error data does not validate", async () => {
    const fn = declareWorkflow({
      workflowName: "processOrder",
      contract,
      activityOptions: { startToCloseTimeout: "1 minute" },
      implementation: async (context) => {
        // @ts-expect-error — deliberately invalid payload
        throw context.errors.EmptyOrder({ orderId: 42 });
      },
    });

    await expect(fn({ orderId: "ORD-1" })).rejects.toBeInstanceOf(ContractErrorDataValidationError);
  });

  it("leaves other thrown errors untouched", async () => {
    const boom = ApplicationFailure.create({ type: "SOMETHING_ELSE", message: "boom" });
    const fn = declareWorkflow({
      workflowName: "processOrder",
      contract,
      activityOptions: { startToCloseTimeout: "1 minute" },
      implementation: async () => {
        throw boom;
      },
    });

    await expect(fn({ orderId: "ORD-1" })).rejects.toBe(boom);
  });
});
