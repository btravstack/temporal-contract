import { defineActivity, defineContract } from "@temporal-contract/contract";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
/**
 * E2e coverage for standalone activities (`startActivity` /
 * `executeActivity` / `getActivityHandle`). Standalone activities need
 * Temporal Server ≥ 1.32, newer than the testcontainers `auto-setup` image
 * (1.29), so this spec runs against the CLI dev server
 * (`TestWorkflowEnvironment.createLocal`) instead.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { type ContractClient, TypedClient } from "../client.js";

const renderPdf = defineActivity({
  input: z.object({ invoiceId: z.string() }),
  output: z.object({ url: z.string() }),
  errors: {
    InvoiceNotFound: { data: z.object({ invoiceId: z.string() }), nonRetryable: true },
  },
  activityOptions: { startToCloseTimeout: "10 seconds", retry: { maximumAttempts: 1 } },
});

const pdfContract = defineContract({
  taskQueue: "standalone-pdf",
  workflows: {},
  activities: { renderPdf },
});

let env: TestWorkflowEnvironment;
let worker: Worker;
let running: Promise<void>;
let pdf: ContractClient<typeof pdfContract>;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: pdfContract.taskQueue,
    activities: {
      renderPdf: async ({ invoiceId }: { invoiceId: string }) => {
        if (invoiceId === "missing") {
          throw ApplicationFailure.create({
            type: "InvoiceNotFound",
            message: "no such invoice",
            details: [{ invoiceId }],
            nonRetryable: true,
          });
        }
        if (invoiceId === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
        return { url: `s3://${invoiceId}.pdf` };
      },
    },
  });
  running = worker.run();
  pdf = (await TypedClient.create({ client: env.client }).get()).for(pdfContract);
}, 120_000);

afterAll(async () => {
  worker?.shutdown();
  await running;
  await env?.teardown();
});

const id = (label: string) => `${label}-${Date.now()}-${Math.random()}`;

describe("standalone activities", () => {
  it("executes on the contract's task queue and parses the output", async () => {
    const result = await pdf.executeActivity("renderPdf", {
      activityId: id("ok"),
      args: { invoiceId: "inv-1" },
    });

    expect(result).toBeOkWith({ url: "s3://inv-1.pdf" });
  });

  it("rehydrates a declared contract error", async () => {
    const result = await pdf.executeActivity("renderPdf", {
      activityId: id("missing"),
      args: { invoiceId: "missing" },
    });

    expect(result).toBeErrTagged("@temporal-contract/ContractError");
    if (result.isErr() && result.error._tag === "@temporal-contract/ContractError") {
      expect(result.error.errorName).toBe("InvoiceNotFound");
      expect(result.error.data).toEqual({ invoiceId: "missing" });
    }
  });

  it("rejects invalid input before starting anything", async () => {
    const result = await pdf.executeActivity("renderPdf", {
      activityId: id("invalid"),
      args: { invoiceId: 42 } as never,
    });

    expect(result).toBeErrTagged("@temporal-contract/ActivityValidationError");
  });

  it("surfaces an ID collision as ActivityAlreadyStartedError", async () => {
    const activityId = id("dup");
    const first = await pdf.startActivity("renderPdf", { activityId, args: { invoiceId: "slow" } });
    expect(first.isOk()).toBe(true);

    const second = await pdf.startActivity("renderPdf", {
      activityId,
      args: { invoiceId: "slow" },
    });
    expect(second).toBeErrTagged("@temporal-contract/ActivityAlreadyStartedError");

    await pdf.getActivityHandle("renderPdf", activityId).terminate("cleanup");
  });

  it("reuses a USE_EXISTING execution only when it is the same activity", async () => {
    const activityId = id("reuse");
    await pdf.startActivity("renderPdf", { activityId, args: { invoiceId: "slow" } });

    const same = await pdf.startActivity("renderPdf", {
      activityId,
      args: { invoiceId: "slow" },
      idConflictPolicy: "USE_EXISTING",
    });
    expect(same.isOk()).toBe(true);

    const other = (await TypedClient.create({ client: env.client }).get()).for(
      defineContract({
        taskQueue: pdfContract.taskQueue,
        workflows: {},
        activities: { stampPdf: renderPdf },
      }),
    );
    const different = await other.startActivity("stampPdf", {
      activityId,
      args: { invoiceId: "slow" },
      idConflictPolicy: "USE_EXISTING",
    });
    expect(different).toBeErrTagged("@temporal-contract/ActivityAlreadyStartedError");

    await pdf.getActivityHandle("renderPdf", activityId).terminate("cleanup");
  });

  it("reattaches by ID and reports termination", async () => {
    const activityId = id("terminate");
    await pdf.startActivity("renderPdf", { activityId, args: { invoiceId: "slow" } });

    const handle = pdf.getActivityHandle("renderPdf", activityId);
    expect(await handle.terminate("bye")).toBeOk();
    expect(await handle.result()).toBeErrTagged("@temporal-contract/ActivityTerminatedError");
    expect((await handle.describe()).isOk()).toBe(true);
  });

  it("reports an unknown activity ID as ActivityExecutionNotFoundError", async () => {
    const result = await pdf.getActivityHandle("renderPdf", id("nope")).describe();

    expect(result).toBeErrTagged("@temporal-contract/ActivityExecutionNotFoundError");
  });

  it("is a defect when the merged options are unbounded", async () => {
    const unbounded = defineContract({
      taskQueue: "standalone-pdf",
      workflows: {},
      activities: {
        renderPdf: defineActivity({ input: renderPdf.input, output: renderPdf.output }),
      },
    });
    const client = (await TypedClient.create({ client: env.client }).get()).for(unbounded);

    const result = await client.startActivity("renderPdf", {
      activityId: id("unbounded"),
      args: { invoiceId: "inv-1" },
      startToCloseTimeout: "10 seconds",
    });

    expect(result.isDefect()).toBe(true);
    if (result.isDefect()) {
      expect((result.cause as Error).message).toContain("missing a total bound");
    }
  });
});
