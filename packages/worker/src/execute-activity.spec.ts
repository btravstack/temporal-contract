import { defineActivity, defineContract } from "@temporal-contract/contract";
/**
 * Runtime coverage for `createExecuteActivity` (`context.executeActivity`):
 * the target contract's task queue wins, options merge workflow default →
 * contract-level → per-call, and misuse (undeclared name, unbounded options)
 * is a defect carrying a `ContractMisuseError`. `proxyActivities` is mocked;
 * the end-to-end routing proof lives in `__tests__/routing.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { proxyActivities, renderPdf } = vi.hoisted(() => {
  const renderPdf = vi.fn(async (_input: unknown): Promise<unknown> => ({ url: "s3://doc.pdf" }));
  return { renderPdf, proxyActivities: vi.fn((_options: unknown) => ({ renderPdf })) };
});

vi.mock("@temporalio/workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@temporalio/workflow")>()),
  proxyActivities,
}));

const { createExecuteActivity } = await import("./activities-proxy.js");
const { ContractMisuseError } = await import("./errors.js");

const pdfContract = defineContract({
  taskQueue: "pdf",
  workflows: {},
  activities: {
    renderPdf: defineActivity({
      input: z.object({ invoiceId: z.string() }),
      output: z.object({ url: z.string() }),
      activityOptions: { startToCloseTimeout: "1 minute" },
    }),
  },
});

describe("createExecuteActivity", () => {
  beforeEach(() => {
    proxyActivities.mockClear();
    renderPdf.mockClear();
  });

  it("dispatches on the target contract's queue with merged options", async () => {
    const execute = createExecuteActivity({
      startToCloseTimeout: "10 seconds",
      retry: { maximumAttempts: 3 },
    });

    const result = await execute(pdfContract, "renderPdf", {
      args: { invoiceId: "inv-1" },
      // A cast past the type, which omits `taskQueue`: the contract still wins.
      ...({ taskQueue: "elsewhere" } as object),
      heartbeatTimeout: "5 seconds",
    });

    expect(result).toBeOkWith({ url: "s3://doc.pdf" });
    expect(proxyActivities).toHaveBeenCalledWith({
      startToCloseTimeout: "1 minute",
      retry: { maximumAttempts: 3 },
      heartbeatTimeout: "5 seconds",
      taskQueue: "pdf",
    });
    expect(renderPdf).toHaveBeenCalledWith({ invoiceId: "inv-1" });
  });

  it("validates args before dispatch", async () => {
    const execute = createExecuteActivity({ scheduleToCloseTimeout: "1 minute" });

    const result = await execute(pdfContract, "renderPdf", { args: { invoiceId: 1 } as never });

    expect(result).toBeErrTagged("@temporal-contract/ActivityError");
    expect(renderPdf).not.toHaveBeenCalled();
  });

  it("is a defect when the merged options lack a total bound", async () => {
    const execute = createExecuteActivity(undefined);

    const result = await execute(pdfContract, "renderPdf", { args: { invoiceId: "inv-1" } });

    expect(result.isDefect()).toBe(true);
    if (result.isDefect()) {
      expect(result.cause).toBeInstanceOf(ContractMisuseError);
      expect((result.cause as Error).message).toContain("missing a total bound");
    }
    expect(proxyActivities).not.toHaveBeenCalled();
  });

  it("is a defect when the contract does not declare the activity", async () => {
    const execute = createExecuteActivity({ scheduleToCloseTimeout: "1 minute" });

    const result = await execute(pdfContract, "missing" as never, { args: {} as never });

    expect(result.isDefect()).toBe(true);
    if (result.isDefect()) {
      expect(result.cause).toBeInstanceOf(ContractMisuseError);
      expect((result.cause as Error).message).toContain('"missing"');
    }
  });
});
